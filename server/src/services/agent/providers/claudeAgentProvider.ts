import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  extractReportDecision,
  extractSessionId,
  parseStreamLine,
} from '../outputParser.js';
import { sanitizePublicContent } from '../eventProtocol.js';
import { serializeReportSubagents } from '../reportSubagent.js';
import { terminateProcessTree } from './processUtils.js';
import type {
  AgentProvider,
  AgentProviderCapabilities,
  AgentProviderHealth,
  ProviderCompletion,
  ProviderEventSink,
  ProviderRun,
  ProviderStartParams,
} from './types.js';

export interface ClaudeAgentProviderConfig {
  workingDirectory: string;
  claudePath: string;
  gitBashPath?: string;
}

function canResolveCommand(command: string): boolean {
  if (!command) return false;
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command);
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return (process.env.PATH ?? '').split(delimiter).some(directory =>
    suffixes.some(suffix => existsSync(join(directory, `${command}${suffix}`))),
  );
}

export function buildClaudeEnvironment(
  source: NodeJS.ProcessEnv,
  gitBashPath?: string,
): NodeJS.ProcessEnv {
  return {
    SystemRoot: source.SystemRoot,
    WINDIR: source.WINDIR,
    PATH: source.PATH,
    PATHEXT: source.PATHEXT,
    TEMP: source.TEMP,
    TMP: source.TMP,
    USERPROFILE: source.USERPROFILE,
    HOMEDRIVE: source.HOMEDRIVE,
    HOMEPATH: source.HOMEPATH,
    APPDATA: source.APPDATA,
    LOCALAPPDATA: source.LOCALAPPDATA,
    ...(gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: gitBashPath } : {}),
  };
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly capabilities: AgentProviderCapabilities = {
    streaming: true,
    resume: true,
    cancel: true,
    approvals: false,
    sandbox: false,
    skills: false,
    mcp: false,
  };
  private children = new Set<ChildProcess>();

  constructor(private config: ClaudeAgentProviderConfig) {}

  health(): AgentProviderHealth {
    let reason: string | null = null;
    if (process.platform !== 'win32') reason = 'Claude Provider 需要 Windows 原生运行环境';
    else if (!isAbsolute(this.config.workingDirectory) || !existsSync(this.config.workingDirectory)) {
      reason = 'Claude 工作目录无效';
    } else if (!canResolveCommand(this.config.claudePath)) reason = 'Claude 可执行文件不可用';
    else if (this.config.gitBashPath && (!isAbsolute(this.config.gitBashPath) || !existsSync(this.config.gitBashPath))) {
      reason = 'Claude Git Bash 路径无效';
    }
    return {
      id: this.id,
      enabled: true,
      available: reason == null,
      reason,
      capabilities: this.capabilities,
    };
  }

  async start(params: ProviderStartParams, sink: ProviderEventSink): Promise<ProviderRun> {
    const args = [
      '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--agents', serializeReportSubagents(), '--dangerously-skip-permissions',
      ...(params.maxTurns > 0 ? ['--max-turns', String(params.maxTurns)] : []),
      ...(params.resumeSessionId ? ['--resume', params.resumeSessionId] : []),
    ];
    const child = spawn(this.config.claudePath, args, {
      cwd: this.config.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildClaudeEnvironment(process.env, this.config.gitBashPath),
    });
    this.children.add(child);

    let settled = false;
    let resolveCompletion!: (value: ProviderCompletion) => void;
    const completion = new Promise<ProviderCompletion>(resolve => { resolveCompletion = resolve; });
    const finish = (value: ProviderCompletion) => {
      if (settled) return;
      settled = true;
      this.children.delete(child);
      resolveCompletion(value);
    };

    let stdoutBuffer = '';
    let sessionCaptured = false;
    let outputQueue = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => {
      outputQueue = outputQueue.then(work).catch(error => {
        console.error(`[Agent/Claude] output processing failed for ${params.runId}:`, error);
      });
    };
    const consumeLine = async (line: string) => {
      const report = extractReportDecision(line);
      if (report) await sink.reportDecision(report.generate);
      if (!sessionCaptured) {
        const sessionId = extractSessionId(line);
        if (sessionId) {
          sessionCaptured = true;
          await sink.session(sessionId);
        }
      }
      for (const event of parseStreamLine(line)) await sink.event(event);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      enqueue(async () => { for (const line of lines) await consumeLine(line); });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const message = sanitizePublicContent(chunk.toString('utf8'), '智能体进程报告错误');
      if (message) enqueue(() => sink.event({
        type: 'error', publicContent: message, timestamp: new Date().toISOString(),
      }));
    });
    child.once('error', error => {
      void outputQueue.then(() => finish({
        status: 'failed', exitCode: null, errorCode: 'SPAWN_ERROR', errorMessage: error.message,
      }));
    });
    child.once('close', exitCode => {
      enqueue(async () => {
        if (stdoutBuffer.trim()) await consumeLine(stdoutBuffer);
        finish(exitCode === 0
          ? { status: 'completed', exitCode }
          : { status: 'failed', exitCode, errorCode: 'PROCESS_EXIT', errorMessage: `进程退出码 ${exitCode}` });
      });
    });
    const imagePaths = (params.attachments ?? [])
      .filter(attachment => attachment.kind === 'image')
      .map(attachment => `- ${JSON.stringify(attachment.name)}: ${attachment.absolutePath}`);
    const prompt = imagePaths.length
      ? `${params.prompt}\n\n## Claude 图片附件路径\n使用 Read 工具查看以下工作区内图片：\n${imagePaths.join('\n')}`
      : params.prompt;
    child.stdin?.end(prompt, 'utf8');

    return {
      pid: child.pid ?? null,
      completion,
      cancel: async () => {
        terminateProcessTree(child);
        await completion;
      },
    };
  }

  async shutdown(): Promise<void> {
    for (const child of this.children) terminateProcessTree(child);
    this.children.clear();
  }
}

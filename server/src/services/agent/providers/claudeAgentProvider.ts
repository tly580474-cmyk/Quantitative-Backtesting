import { spawn, type ChildProcess } from 'node:child_process';
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
  wslProjectPath: string;
  claudePath: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
    return {
      id: this.id,
      enabled: true,
      available: Boolean(this.config.claudePath && this.config.wslProjectPath),
      reason: this.config.claudePath && this.config.wslProjectPath ? null : 'Claude 路径或工作目录未配置',
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
    const command = `mkdir -p ${shellQuote(this.config.wslProjectPath)} && cd ${shellQuote(this.config.wslProjectPath)} && exec ${shellQuote(this.config.claudePath)} ${args.map(shellQuote).join(' ')}`;
    const child = spawn('wsl', ['bash', '-lc', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PATH: process.env.PATH,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
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
    child.stdin?.end(params.prompt, 'utf8');

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

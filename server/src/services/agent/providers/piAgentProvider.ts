import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildClaudeEnvironment } from './claudeAgentProvider.js';
import { terminateProcessTree } from './processUtils.js';
import { parseStreamLine, extractReportDirective } from '../outputParser.js';
import { sanitizePublicContent, sanitizeToolDetail, sanitizeToolName } from '../eventProtocol.js';
import { detectToolFailure, researchDataUsable } from '../toolOutcome.js';
import { fundFlowEvidence } from '../fundFlowReportGuard.js';
import type { AgentProvider, AgentProviderHealth, ProviderCompletion, ProviderEventSink, ProviderRun, ProviderStartParams } from './types.js';

export interface PiAgentProviderConfig {
  enabled: boolean;
  piPath: string;
  workingDirectory: string;
  agentDirectory: string;
  model?: string;
  modelProvider?: string;
}
const now = () => new Date().toISOString();
const textBlocks = (content: any) => Array.isArray(content)
  ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';

/** Pi JSON mode v0.85: never persist thinking blocks or raw agent_end.messages. */
export class PiAgentProvider implements AgentProvider {
  readonly id = 'pi' as const;
  readonly capabilities = { streaming: true, resume: true, cancel: true, approvals: false, sandbox: false, skills: false, mcp: false };
  private children = new Set<ChildProcess>();
  constructor(private config: PiAgentProviderConfig) {}
  health(): AgentProviderHealth {
    const reason = !this.config.enabled ? 'Pi Provider 未启用'
      : !isAbsolute(this.config.piPath) || !existsSync(this.config.piPath) ? 'Pi 可执行文件须配置为绝对路径'
      : !isAbsolute(this.config.workingDirectory) || !existsSync(this.config.workingDirectory) ? 'Pi 工作目录无效'
      : !isAbsolute(this.config.agentDirectory) || !existsSync(this.config.agentDirectory) ? 'Pi 专用配置目录无效' : null;
    return { id: this.id, enabled: this.config.enabled, available: !reason, reason, capabilities: this.capabilities };
  }
  async start(params: ProviderStartParams, sink: ProviderEventSink): Promise<ProviderRun> {
    const health = this.health();
    if (!health.available) throw new Error(health.reason!);
    if (params.resumeSessionId && !/^[a-f0-9-]{36}$/i.test(params.resumeSessionId)) throw new Error('Invalid Pi session id');
    const sessionDirectory = join(this.config.agentDirectory, 'sessions');
    await mkdir(sessionDirectory, { recursive: true });
    const args = ['--mode', 'json', '--print', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-approve', '--tools', 'read,bash,edit,write,grep,find,ls',
      '--session-dir', sessionDirectory,
      ...(params.resumeSessionId ? ['--session', params.resumeSessionId] : []),
      ...(this.config.modelProvider ? ['--provider', this.config.modelProvider] : []),
      ...(this.config.model ? ['--model', this.config.model] : [])];
    const child = spawn(this.config.piPath, args, { cwd: this.config.workingDirectory,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildClaudeEnvironment(process.env), PI_CODING_AGENT_DIR: this.config.agentDirectory, PI_TELEMETRY: '0' } });
    this.children.add(child);
    let canceled = false, ended = false, lastText = '', failure: string | undefined, errorCode: string | undefined;
    let turns = 0, messages = 0, settled = false;
    let queue = Promise.resolve();
    let resolveCompletion!: (value: ProviderCompletion) => void;
    const completion = new Promise<ProviderCompletion>(resolve => { resolveCompletion = resolve; });
    const finish = (value: ProviderCompletion) => {
      if (settled) return;
      settled = true; this.children.delete(child); resolveCompletion(value);
    };
    const abort = (code: string, message: string) => { errorCode = code; failure = message; terminateProcessTree(child); };
    const consume = async (line: string) => {
      if (line.length > 8_000_000) { abort('PI_OUTPUT_LIMIT', 'Pi 输出超过上限'); return; }
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'session' && typeof event.id === 'string' && /^[a-f0-9-]{36}$/i.test(event.id)) await sink.session(event.id);
      if (event.type === 'turn_start' && params.maxTurns > 0 && ++turns > params.maxTurns) abort('MAX_TURNS', '达到Pi轮次上限');
      if (event.type === 'tool_execution_start') await sink.event({ type: 'tool_started', timestamp: now(),
        publicContent: `执行 ${sanitizeToolName(event.toolName)}`, toolName: sanitizeToolName(event.toolName),
        toolUseId: event.toolCallId, toolInput: sanitizeToolDetail(event.args) });
      if (event.type === 'tool_execution_end') {
        const raw = textBlocks(event.result?.content);
        const failed = detectToolFailure(raw, event.isError === true);
        await sink.event({ type: failed ? 'error' : 'tool_finished', timestamp: now(),
          publicContent: `${sanitizeToolName(event.toolName)} ${failed ? '执行失败' : '执行完成'}`,
          toolName: sanitizeToolName(event.toolName), toolUseId: event.toolCallId, toolResult: sanitizeToolDetail(raw),
          toolFailure: failed, toolDataUsable: researchDataUsable(raw), toolFundFlowEvidence: fundFlowEvidence(raw) });
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const message = event.message;
        const text = textBlocks(message.content);
        if (text) {
          lastText = text;
          await sink.event({ type: 'progress', timestamp: now(), publicContent: sanitizePublicContent(extractReportDirective(text).answer) });
        }
        if (['error', 'aborted'].includes(message.stopReason)) {
          failure = sanitizePublicContent(message.errorMessage, 'Pi模型请求失败'); errorCode = 'PI_MODEL_ERROR';
        }
        if (message.usage) sink.telemetry?.({ model: message.model, messageId: `pi-${++messages}`, usageScope: 'message',
          usage: { inputTokens: (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0),
            cachedInputTokens: message.usage.cacheRead ?? 0, outputTokens: message.usage.output ?? 0 } });
      }
      if (event.type === 'agent_end') ended = true;
    };
    createInterface({ input: child.stdout! }).on('line', line => {
      queue = queue.then(() => consume(line)).catch(error => abort('PI_OUTPUT_ERROR', sanitizePublicContent(error.message)));
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', error => { void queue.then(() => finish({ status: 'failed', exitCode: null, errorCode: 'SPAWN_ERROR', errorMessage: sanitizePublicContent(error.message) })); });
    child.once('close', code => {
      void queue.then(async () => {
        if (canceled) return finish({ status: 'interrupted', exitCode: code });
        if (code !== 0 || failure || !ended || !lastText) return finish({ status: 'failed', exitCode: code,
          errorCode: errorCode ?? 'PI_INCOMPLETE', errorMessage: failure ?? sanitizePublicContent(stderr, 'Pi没有完成有效回答') });
        const directive = extractReportDirective(lastText);
        if (directive.decision) await sink.reportDecision(directive.decision.generate);
        for (const event of parseStreamLine(JSON.stringify({ type: 'result', result: lastText }))) await sink.event(event);
        finish({ status: 'completed', exitCode: 0 });
      }).catch(error => finish({ status: 'failed', exitCode: code, errorCode: 'PI_OUTPUT_ERROR', errorMessage: sanitizePublicContent(error.message) }));
    });
    const images = (params.attachments ?? []).filter(a => a.kind === 'image').map(a => `- ${a.absolutePath}`).join('\n');
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${params.prompt}${images ? `\n\n使用 read 工具查看用户图片附件：\n${images}` : ''}`);
    return { pid: child.pid ?? null, completion, cancel: async () => { canceled = true; terminateProcessTree(child); await completion; } };
  }
  async shutdown(): Promise<void> { for (const child of this.children) terminateProcessTree(child); this.children.clear(); }
}

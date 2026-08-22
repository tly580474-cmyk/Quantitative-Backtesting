import { spawn, type ChildProcess } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Pool } from 'mysql2/promise';
import { buildPrompt, type TemplateStyle } from './promptBuilder.js';
import { parseStreamLine, extractReportDecision, extractSessionId, type ParsedEvent } from './outputParser.js';
import { sanitizePublicContent, type TerminalPayload, type TerminalStatus } from './eventProtocol.js';
import { AgentRepository } from './agentRepository.js';
import { validateAgentReport } from './reportValidator.js';
import { renderStaticAgentReport } from './reportRenderer.js';
import { serializeReportSubagents } from './reportSubagent.js';

export interface OrchestratorConfig {
  wslProjectPath: string;
  claudePath: string;
  reportRoot: string;
  maxConcurrent: number;
}

export interface StartParams {
  runId: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  templateStyle?: string;
  resumeSessionId?: string;
}

interface ActiveRun {
  process: ChildProcess | null;
  seq: number;
  finalized: boolean;
  timer?: NodeJS.Timeout;
  outputQueue: Promise<void>;
  toolStartedAt: Map<string, number>;
  toolNames: Map<string, string>;
  accepting: boolean;
  shouldGenerateReport: boolean | null;
  finalContent: string;
  lastEventType?: ParsedEvent['type'];
  lastEventContent?: string;
  templateStyle: TemplateStyle;
}

type EventListener = (event: ParsedEvent, seq: number) => void;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class AgentOrchestrator {
  private activeRuns = new Map<string, ActiveRun>();
  private eventListeners = new Map<string, Set<EventListener>>();

  constructor(private pool: Pool, private config: OrchestratorConfig) {}

  async initialize(): Promise<number> {
    return new AgentRepository(this.pool).reconcileOrphanedRuns();
  }

  async start(params: StartParams): Promise<void> {
    const repo = new AgentRepository(this.pool);
    // Reserve synchronously before the first await so concurrent starts cannot oversubscribe.
    if (this.activeRuns.size >= this.config.maxConcurrent) {
      const message = '智能体当前正忙，请等待正在运行的任务结束后重试';
      const transitioned = await repo.transitionRun(params.runId, ['pending'], 'failed', {
        exitCode: null, errorCode: 'CONCURRENCY_LIMIT', errorMessage: message,
      });
      if (transitioned) {
        await repo.addPublicEvent(params.runId, await repo.getLastSeq(params.runId) + 1, {
          type: 'terminal', publicContent: message, timestamp: new Date().toISOString(),
          terminal: { status: 'failed', exitCode: null, errorCode: 'CONCURRENCY_LIMIT' },
        });
      }
      throw new Error(message);
    }
    if (this.activeRuns.has(params.runId)) throw new Error('运行已启动');
    const templateStyle = params.templateStyle as TemplateStyle ?? 'classic-blue';
    const active: ActiveRun = {
      process: null, seq: 0, finalized: false, outputQueue: Promise.resolve(),
      toolStartedAt: new Map(), toolNames: new Map(), accepting: true,
      shouldGenerateReport: null, finalContent: '', templateStyle,
    };
    this.activeRuns.set(params.runId, active);

    try {
      const claimed = await repo.transitionRun(params.runId, ['pending'], 'starting');
      if (!claimed) throw new Error('运行状态不允许启动');
      active.seq = await repo.getLastSeq(params.runId);

      const reportDir = resolve(this.config.reportRoot, 'reports');
      await mkdir(reportDir, { recursive: true });

      const prompt = buildPrompt(
        params.prompt, this.config.wslProjectPath, templateStyle,
        Boolean(params.resumeSessionId),
      );
      const args = [
        '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--agents', serializeReportSubagents(),
        '--dangerously-skip-permissions',
        ...(params.maxTurns > 0 ? ['--max-turns', String(params.maxTurns)] : []),
        ...(params.resumeSessionId ? ['--resume', params.resumeSessionId] : []),
      ];
      const command = `mkdir -p ${shellQuote(this.config.wslProjectPath)} && cd ${shellQuote(this.config.wslProjectPath)} && exec ${shellQuote(this.config.claudePath)} ${args.map(shellQuote).join(' ')}`;
      const child = spawn('wsl', ['bash', '-lc', command], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        // Do not pass the backend's database, admin, SMTP or provider credentials to the child.
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      });
      active.process = child;
      const running = await repo.transitionRun(params.runId, ['starting'], 'running', { pid: child.pid ?? null });
      if (!running) {
        this.killProcessTree(child);
        throw new Error('运行在启动期间被取消');
      }
      await this.publish(params.runId, active, repo, {
        type: 'progress',
        publicContent: '智能体已启动，正在分析任务',
        timestamp: new Date().toISOString(),
      });

      let stdoutBuffer = '';
      let sessionCaptured = false;
      const consumeLine = async (line: string) => {
        const reportDecision = extractReportDecision(line);
        if (reportDecision) active.shouldGenerateReport = reportDecision.generate;
        if (!sessionCaptured) {
          const sessionId = extractSessionId(line);
          if (sessionId) {
            sessionCaptured = true;
            await repo.updateSessionId(params.runId, sessionId);
          }
        }
        for (const event of parseStreamLine(line)) await this.publish(params.runId, active, repo, event);
      };
      const enqueue = (work: () => Promise<void>) => {
        if (!active.accepting) return;
        active.outputQueue = active.outputQueue.then(work).catch(error => {
          console.error(`[Agent] output processing failed for ${params.runId}:`, error);
        });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        enqueue(async () => { for (const line of lines) await consumeLine(line); });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const message = sanitizePublicContent(chunk.toString('utf8'), '智能体进程报告错误');
        if (message) enqueue(() => this.publish(params.runId, active, repo, {
          type: 'error', publicContent: message, timestamp: new Date().toISOString(),
        }));
      });

      active.timer = setTimeout(() => {
        active.accepting = false;
        this.killProcessTree(child);
        void active.outputQueue.then(() => this.finalize(params.runId, active, repo, 'failed', null, 'TIMEOUT', '运行超时'));
      }, params.timeoutMs);

      child.once('error', error => {
        active.accepting = false;
        void active.outputQueue.then(() => this.finalize(params.runId, active, repo, 'failed', null, 'SPAWN_ERROR', error.message));
      });
      child.once('close', exitCode => {
        enqueue(async () => {
          if (stdoutBuffer.trim()) await consumeLine(stdoutBuffer);
          active.accepting = false;
          await this.finalize(
            params.runId, active, repo, exitCode === 0 ? 'completed' : 'failed', exitCode,
            exitCode === 0 ? undefined : 'PROCESS_EXIT', exitCode === 0 ? undefined : `进程退出码 ${exitCode}`,
          );
        });
      });

      child.stdin?.end(prompt, 'utf8');
    } catch (error) {
      await this.finalize(
        params.runId, active, repo, 'failed', null, 'STARTUP_ERROR',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async publish(runId: string, active: ActiveRun, repo: AgentRepository, event: ParsedEvent): Promise<void> {
    if (active.finalized && event.type !== 'terminal') return;
    if (event.type === 'progress' && active.lastEventType === 'progress'
      && active.lastEventContent === event.publicContent) return;
    if (event.type === 'tool_started' && event.toolUseId) {
      // Partial stream events announce the tool before the complete assistant
      // message repeats it. Keep one public start event per tool call.
      if (active.toolStartedAt.has(event.toolUseId)) return;
      active.toolStartedAt.set(event.toolUseId, Date.now());
      if (event.toolName) active.toolNames.set(event.toolUseId, event.toolName);
    }
    if (event.type === 'assistant_final') active.finalContent = event.publicContent;
    if (event.type === 'tool_finished' && event.toolUseId) {
      const started = active.toolStartedAt.get(event.toolUseId);
      if (started) event.durationMs = Math.max(0, Date.now() - started);
      event.toolName = event.toolName ?? active.toolNames.get(event.toolUseId);
      active.toolStartedAt.delete(event.toolUseId);
      active.toolNames.delete(event.toolUseId);
    }
    const seq = ++active.seq;
    await repo.addPublicEvent(runId, seq, event);
    active.lastEventType = event.type;
    active.lastEventContent = event.publicContent;
    this.notifyListeners(runId, event, seq);
  }

  private async finalize(
    runId: string, active: ActiveRun, repo: AgentRepository, status: TerminalStatus,
    exitCode: number | null, errorCode?: string, errorMessage?: string,
  ): Promise<boolean> {
    if (active.finalized) return false;
    active.accepting = false;
    active.finalized = true;
    if (active.timer) clearTimeout(active.timer);
    let targetStatus = status;
    let targetErrorCode = errorCode;
    let targetErrorMessage = errorMessage;
    if (status === 'completed' && active.shouldGenerateReport === true) {
      const reportSaved = active.finalContent
        ? await this.createStaticReport(runId, active.finalContent, repo, active.templateStyle)
        : false;
      if (!reportSaved) {
        targetStatus = 'failed';
        targetErrorCode = 'REPORT_INVALID_OR_MISSING';
        targetErrorMessage = '报告缺失或未通过静态安全校验';
      }
    }
    const transitioned = await repo.transitionRun(
      runId, ['pending', 'starting', 'running'], targetStatus,
      { exitCode, errorCode: targetErrorCode ?? null, errorMessage: targetErrorMessage ?? null },
    );
    if (!transitioned) {
      this.activeRuns.delete(runId);
      return false;
    }
    const terminal: TerminalPayload = {
      status: targetStatus, exitCode, ...(targetErrorCode ? { errorCode: targetErrorCode } : {}),
    };
    // Terminal is persisted before listeners see it, making reconnect replay authoritative.
    active.finalized = false;
    await this.publish(runId, active, repo, {
      type: 'terminal', publicContent: targetErrorMessage ?? '', timestamp: new Date().toISOString(), terminal,
    });
    active.finalized = true;
    this.activeRuns.delete(runId);
    return true;
  }

  private async createStaticReport(
    runId: string,
    content: string,
    repo: AgentRepository,
    templateStyle: TemplateStyle,
  ): Promise<boolean> {
    try {
      const rendered = renderStaticAgentReport(content, templateStyle);
      const bytes = Buffer.byteLength(rendered.html);
      const validation = validateAgentReport(rendered.html, bytes);
      if (!validation.valid) return false;
      const reportPath = resolve(this.config.reportRoot, 'reports', `${runId}.html`);
      await writeFile(reportPath, rendered.html, 'utf8');
      await repo.saveReport(runId, rendered.title, reportPath, bytes, rendered.summary, 0);
      return true;
    } catch {
      return false;
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.accepting = false;
    if (active.process) this.killProcessTree(active.process);
    await active.outputQueue;
    const canceled = await this.finalize(runId, active, new AgentRepository(this.pool), 'canceled', null, 'CANCELED', '已由用户取消');
    return canceled;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.activeRuns.keys()].map(runId => this.cancel(runId)));
  }

  isRunning(runId: string): boolean { return this.activeRuns.has(runId); }

  getRuntimeStats(): { active: number; capacity: number } {
    return { active: this.activeRuns.size, capacity: this.config.maxConcurrent };
  }

  addEventListener(runId: string, listener: EventListener): () => void {
    const listeners = this.eventListeners.get(runId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.eventListeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(runId);
    };
  }

  private notifyListeners(runId: string, event: ParsedEvent, seq: number): void {
    for (const listener of this.eventListeners.get(runId) ?? []) listener(event, seq);
  }

  private killProcessTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } else {
      child.kill('SIGTERM');
    }
  }
}

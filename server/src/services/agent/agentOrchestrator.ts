import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'mysql2/promise';
import { buildPrompt, type TemplateStyle } from './promptBuilder.js';
import type { ParsedEvent } from './outputParser.js';
import { type TerminalPayload, type TerminalStatus } from './eventProtocol.js';
import { AgentRepository } from './agentRepository.js';
import { validateAgentReport } from './reportValidator.js';
import { renderStaticAgentReport } from './reportRenderer.js';
import { ClaudeAgentProvider } from './providers/claudeAgentProvider.js';
import { CodexAgentProvider } from './providers/codexAgentProvider.js';
import type { AgentProvider, AgentProviderHealth, AgentProviderId, ProviderRun } from './providers/types.js';
import type { AgentApprovalRecord } from './agentRepository.js';

export interface OrchestratorConfig {
  wslProjectPath: string;
  claudePath: string;
  reportRoot: string;
  maxConcurrent: number;
  defaultProvider?: AgentProviderId;
  codex?: {
    enabled: boolean;
    codexPath: string;
    workingDirectory: string;
    codexHome: string;
    apiKey: string;
    modelProvider?: string;
    baseUrl?: string;
    modelCatalogPath?: string;
    model?: string;
    approvalsEnabled?: boolean;
    approvalTimeoutMs?: number;
    toolsEnabled?: boolean;
    sandboxMode?: 'read-only' | 'workspace-write';
    windowsSandbox?: 'elevated' | 'unelevated';
    networkEnabled?: boolean;
    externalDataSkillEnabled?: boolean;
    pythonPath?: string;
    marketDataCliPath?: string;
  };
}

export interface StartParams {
  runId: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  templateStyle?: string;
  resumeSessionId?: string;
  provider?: AgentProviderId;
}

interface ActiveRun {
  providerId: AgentProviderId;
  providerRun: ProviderRun | null;
  seq: number;
  finalized: boolean;
  cancelRequested: boolean;
  timeoutRequested: boolean;
  timer?: NodeJS.Timeout;
  toolStartedAt: Map<string, number>;
  toolNames: Map<string, string>;
  shouldGenerateReport: boolean | null;
  finalContent: string;
  lastEventType?: ParsedEvent['type'];
  lastEventContent?: string;
  templateStyle: TemplateStyle;
}

interface PendingApprovalRuntime {
  runId: string;
  resolve: (decision: 'approved' | 'denied') => void;
  timer: NodeJS.Timeout;
}

type EventListener = (event: ParsedEvent, seq: number) => void;

export class AgentOrchestrator {
  private activeRuns = new Map<string, ActiveRun>();
  private eventListeners = new Map<string, Set<EventListener>>();
  private providers = new Map<AgentProviderId, AgentProvider>();
  private defaultProvider: AgentProviderId;
  private pendingApprovals = new Map<string, PendingApprovalRuntime>();

  constructor(private pool: Pool, private config: OrchestratorConfig, providers?: AgentProvider[]) {
    this.defaultProvider = config.defaultProvider ?? 'claude';
    const configuredProviders = providers ?? [
      new ClaudeAgentProvider({ wslProjectPath: config.wslProjectPath, claudePath: config.claudePath }),
      new CodexAgentProvider(config.codex ?? {
        enabled: false, codexPath: 'codex', workingDirectory: '', codexHome: '', apiKey: '', model: '',
      }),
    ];
    for (const provider of configuredProviders) this.providers.set(provider.id, provider);
  }

  async initialize(): Promise<number> {
    return new AgentRepository(this.pool).reconcileOrphanedRuns();
  }

  async start(params: StartParams): Promise<void> {
    const repo = new AgentRepository(this.pool);
    const providerId = params.provider ?? this.defaultProvider;
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`未知 Agent Provider: ${providerId}`);
    const health = provider.health();
    if (!health.enabled || !health.available) {
      const message = health.reason ?? `${providerId} Provider 不可用`;
      await this.failPendingRun(repo, params.runId, 'PROVIDER_UNAVAILABLE', message);
      throw new Error(message);
    }
    if (this.activeRuns.size >= this.config.maxConcurrent) {
      const message = '智能体当前正忙，请等待正在运行的任务结束后重试';
      await this.failPendingRun(repo, params.runId, 'CONCURRENCY_LIMIT', message);
      throw new Error(message);
    }
    if (this.activeRuns.has(params.runId)) throw new Error('运行已启动');
    const templateStyle = params.templateStyle as TemplateStyle ?? 'classic-blue';
    const active: ActiveRun = {
      providerId, providerRun: null, seq: 0, finalized: false, cancelRequested: false, timeoutRequested: false,
      toolStartedAt: new Map(), toolNames: new Map(), shouldGenerateReport: null,
      finalContent: '', templateStyle,
    };
    this.activeRuns.set(params.runId, active);

    try {
      const claimed = await repo.transitionRun(params.runId, ['pending'], 'starting');
      if (!claimed) throw new Error('运行状态不允许启动');
      active.seq = await repo.getLastSeq(params.runId);
      await mkdir(resolve(this.config.reportRoot, 'reports'), { recursive: true });
      const workingDirectory = providerId === 'codex'
        ? this.config.codex?.workingDirectory ?? ''
        : this.config.wslProjectPath;
      const prompt = buildPrompt(
        params.prompt, workingDirectory, templateStyle, Boolean(params.resumeSessionId), providerId,
        providerId === 'codex' ? {
          marketDataCliPath: this.config.codex?.marketDataCliPath,
          externalDataSkillEnabled: this.config.codex?.externalDataSkillEnabled,
          pythonPath: this.config.codex?.pythonPath,
          sandboxMode: this.config.codex?.sandboxMode,
          approvalsEnabled: this.config.codex?.approvalsEnabled,
          networkEnabled: this.config.codex?.networkEnabled,
        } : undefined,
      );
      const providerRun = await provider.start({
        runId: params.runId, prompt, maxTurns: params.maxTurns, resumeSessionId: params.resumeSessionId,
      }, {
        event: event => this.publish(params.runId, active, repo, event),
        session: sessionId => repo.updateSessionId(params.runId, sessionId),
        reportDecision: async generate => { active.shouldGenerateReport = generate; },
        approval: async request => {
          const approvalId = crypto.randomUUID();
          const timeoutMs = Math.max(10_000, this.config.codex?.approvalTimeoutMs ?? 300_000);
          const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
          const approval = await repo.createApproval({
            id: approvalId, runId: params.runId, provider: providerId,
            threadId: request.threadId, turnId: request.turnId, itemId: request.itemId,
            requestType: request.requestType, summary: request.summary, expiresAt,
          });
          await this.publish(params.runId, active, repo, {
            type: 'confirmation_required', publicContent: request.summary, timestamp: new Date().toISOString(),
            approval: this.publicApproval(approval),
          });
          return new Promise<'approved' | 'denied'>(resolveDecision => {
            const timer = setTimeout(() => {
              void repo.decideApproval(approvalId, 'expired').then(expired => {
                this.pendingApprovals.delete(approvalId);
                if (expired) void this.publish(params.runId, active, repo, {
                  type: 'confirmation_required', publicContent: expired.summary, timestamp: new Date().toISOString(),
                  approval: this.publicApproval(expired),
                });
                resolveDecision('denied');
              }).catch(() => {
                this.pendingApprovals.delete(approvalId);
                resolveDecision('denied');
              });
            }, timeoutMs);
            this.pendingApprovals.set(approvalId, { runId: params.runId, resolve: resolveDecision, timer });
          });
        },
      });
      active.providerRun = providerRun;
      if (active.cancelRequested || active.finalized) {
        await providerRun.cancel();
        return;
      }
      const running = await repo.transitionRun(params.runId, ['starting'], 'running', { pid: providerRun.pid });
      if (!running) {
        await providerRun.cancel();
        throw new Error('运行在启动期间被取消');
      }
      active.timer = setTimeout(() => {
        active.timeoutRequested = true;
        void providerRun.cancel().catch(() => undefined).then(() => this.finalize(
          params.runId, active, repo, 'failed', null, 'TIMEOUT', '运行超时',
        ));
      }, params.timeoutMs);
      void providerRun.completion.then(completion => {
        if (active.finalized) return false;
        if (completion.status === 'completed') {
          return this.finalize(params.runId, active, repo, 'completed', completion.exitCode);
        }
        if (completion.status === 'interrupted' && active.timeoutRequested) {
          return this.finalize(params.runId, active, repo, 'failed', null, 'TIMEOUT', '运行超时');
        }
        if (completion.status === 'interrupted' && active.cancelRequested) {
          return this.finalize(params.runId, active, repo, 'canceled', null, 'CANCELED', '已由用户取消');
        }
        return this.finalize(
          params.runId, active, repo, 'failed', completion.exitCode,
          completion.errorCode ?? (completion.status === 'interrupted' ? 'PROVIDER_INTERRUPTED' : 'PROVIDER_FAILED'),
          completion.errorMessage ?? (completion.status === 'interrupted' ? 'Provider 意外中断' : 'Provider 运行失败'),
        );
      }).catch(error => this.finalize(
        params.runId, active, repo, 'failed', null, 'PROVIDER_COMPLETION_ERROR',
        error instanceof Error ? error.message : String(error),
      ));
    } catch (error) {
      if (!active.finalized) {
        await this.finalize(
          params.runId, active, repo, 'failed', null, 'STARTUP_ERROR',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  private async failPendingRun(repo: AgentRepository, runId: string, errorCode: string, message: string): Promise<void> {
    const transitioned = await repo.transitionRun(runId, ['pending'], 'failed', {
      exitCode: null, errorCode, errorMessage: message,
    });
    if (transitioned) {
      await repo.addPublicEvent(runId, await repo.getLastSeq(runId) + 1, {
        type: 'terminal', publicContent: message, timestamp: new Date().toISOString(),
        terminal: { status: 'failed', exitCode: null, errorCode },
      });
    }
  }

  private async publish(runId: string, active: ActiveRun, repo: AgentRepository, event: ParsedEvent): Promise<void> {
    if (active.finalized && event.type !== 'terminal') return;
    if (event.type === 'progress' && active.lastEventType === 'progress'
      && active.lastEventContent === event.publicContent) return;
    if (event.type === 'tool_started' && event.toolUseId) {
      if (active.toolStartedAt.has(event.toolUseId)) return;
      active.toolStartedAt.set(event.toolUseId, Date.now());
      if (event.toolName) active.toolNames.set(event.toolUseId, event.toolName);
    }
    if (event.type === 'assistant_final') active.finalContent = event.publicContent;
    if (event.type === 'tool_finished' && event.toolUseId) {
      const started = active.toolStartedAt.get(event.toolUseId);
      if (started && event.durationMs == null) event.durationMs = Math.max(0, Date.now() - started);
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
    active.finalized = true;
    if (active.timer) clearTimeout(active.timer);
    await this.cancelApprovalsForRun(runId, repo);
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
    active.finalized = false;
    await this.publish(runId, active, repo, {
      type: 'terminal', publicContent: targetErrorMessage ?? '', timestamp: new Date().toISOString(), terminal,
    });
    active.finalized = true;
    this.activeRuns.delete(runId);
    return true;
  }

  private async createStaticReport(
    runId: string, content: string, repo: AgentRepository, templateStyle: TemplateStyle,
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
    if (!active || active.finalized) return false;
    active.cancelRequested = true;
    if (active.providerRun) await active.providerRun.cancel().catch(() => undefined);
    // Provider completion may win the race and publish the canceled terminal while
    // cancel() is awaiting resource cleanup. That is still a successful cancel.
    if (active.finalized) return true;
    return this.finalize(
      runId, active, new AgentRepository(this.pool), 'canceled', null, 'CANCELED', '已由用户取消',
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.activeRuns.keys()].map(runId => this.cancel(runId)));
    await Promise.all([...this.providers.values()].map(provider => provider.shutdown()));
  }

  async listPendingApprovals(runId?: string): Promise<AgentApprovalRecord[]> {
    return new AgentRepository(this.pool).listPendingApprovals(runId);
  }

  async decideApproval(id: string, decision: 'approved' | 'denied'): Promise<AgentApprovalRecord | null> {
    const repo = new AgentRepository(this.pool);
    const current = await repo.getApproval(id);
    if (!current) return null;
    if (current.status !== 'pending') return current;
    const runtime = this.pendingApprovals.get(id);
    if (!runtime || runtime.runId !== current.runId) {
      return repo.decideApproval(id, 'canceled');
    }
    const updated = await repo.decideApproval(id, decision);
    if (!updated || updated.status !== decision) return updated;
    clearTimeout(runtime.timer);
    this.pendingApprovals.delete(id);
    runtime.resolve(decision);
    const active = this.activeRuns.get(current.runId);
    if (active && !active.finalized) {
      await this.publish(current.runId, active, repo, {
        type: 'confirmation_required', publicContent: updated.summary, timestamp: new Date().toISOString(),
        approval: this.publicApproval(updated),
      });
    }
    return updated;
  }

  private publicApproval(approval: AgentApprovalRecord): NonNullable<ParsedEvent['approval']> {
    return { id: approval.id, requestType: approval.requestType, status: approval.status,
      expiresAt: approval.expiresAt, summary: approval.summary };
  }

  private async cancelApprovalsForRun(runId: string, repo: AgentRepository): Promise<void> {
    await repo.cancelPendingApprovals(runId);
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.runId !== runId) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(id);
      pending.resolve('denied');
    }
  }

  isRunning(runId: string): boolean { return this.activeRuns.has(runId); }

  getRuntimeStats(): { active: number; capacity: number } {
    return { active: this.activeRuns.size, capacity: this.config.maxConcurrent };
  }

  getProviderHealth(): AgentProviderHealth[] {
    return [...this.providers.values()].map(provider => provider.health());
  }

  getDefaultProvider(): AgentProviderId { return this.defaultProvider; }

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
}

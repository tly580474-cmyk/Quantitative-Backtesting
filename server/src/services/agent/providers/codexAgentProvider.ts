import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { extractReportDirective } from '../outputParser.js';
import { sanitizePublicContent, sanitizeToolName } from '../eventProtocol.js';
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

export interface CodexAgentProviderConfig {
  enabled: boolean;
  codexPath: string;
  workingDirectory: string;
  codexHome: string;
  apiKey: string;
  modelProvider?: string;
  baseUrl?: string;
  modelCatalogPath?: string;
  model?: string;
  requestTimeoutMs?: number;
  approvalsEnabled?: boolean;
  toolsEnabled?: boolean;
  sandboxMode?: 'read-only' | 'workspace-write';
  windowsSandbox?: 'elevated' | 'unelevated';
  networkEnabled?: boolean;
  externalDataSkillEnabled?: boolean;
  pythonPath?: string;
  marketDataCliPath?: string;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function now(): string { return new Date().toISOString(); }

function canResolveCommand(command: string, source: NodeJS.ProcessEnv): boolean {
  if (!command) return false;
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command);
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  return (source.PATH ?? '').split(delimiter).some(directory =>
    suffixes.some(suffix => existsSync(join(directory, `${command}${suffix}`))),
  );
}

export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
  providerApiKey?: string,
  pythonPath?: string,
): NodeJS.ProcessEnv {
  const pythonDirectory = pythonPath ? dirname(pythonPath) : '';
  return {
    SystemRoot: source.SystemRoot,
    WINDIR: source.WINDIR,
    PATH: pythonDirectory ? `${pythonDirectory}${delimiter}${source.PATH ?? ''}` : source.PATH,
    PATHEXT: source.PATHEXT,
    TEMP: source.TEMP,
    TMP: source.TMP,
    CODEX_HOME: codexHome,
    ...(providerApiKey ? { CODEX_PROVIDER_API_KEY: providerApiKey } : {}),
  };
}

function isValidProviderId(value: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(value);
}

function isValidApiBaseUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function publicToolName(item: Record<string, any>): string {
  if (item.type === 'commandExecution') return 'command';
  if (item.type === 'fileChange') return 'file_change';
  if (item.type === 'mcpToolCall') return sanitizeToolName(`${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`) ?? 'mcp';
  if (item.type === 'dynamicToolCall') return sanitizeToolName(item.tool) ?? 'tool';
  return sanitizeToolName(item.type) ?? 'tool';
}

function isToolItem(item: Record<string, any>): boolean {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type);
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly capabilities: AgentProviderCapabilities;
  private get approvalPolicy(): 'on-request' | 'never' { return this.config.approvalsEnabled ? 'on-request' : 'never'; }
  constructor(private config: CodexAgentProviderConfig) {
    this.capabilities = {
    streaming: true,
    resume: true,
    cancel: true,
    approvals: Boolean(config.approvalsEnabled),
    sandbox: true,
    skills: Boolean(config.externalDataSkillEnabled),
    mcp: false,
    };
  }
  private children = new Set<ChildProcess>();
  private lastError: string | null = null;

  health(): AgentProviderHealth {
    let structuralReason: string | null = null;
    if (!this.config.enabled) structuralReason = 'Codex Provider 未启用';
    else if (!isAbsolute(this.config.workingDirectory) || !existsSync(this.config.workingDirectory)) structuralReason = 'Codex 工作目录无效';
    else if (!isAbsolute(this.config.codexHome) || !existsSync(this.config.codexHome)) structuralReason = 'Codex 状态目录无效';
    else if (this.config.externalDataSkillEnabled
      && !existsSync(join(this.config.codexHome, 'skills', 'a-stock-data', 'SKILL.md'))) structuralReason = 'Codex A股外部补缺技能不可用';
    else if (!canResolveCommand(this.config.codexPath, process.env)) structuralReason = 'Codex 可执行文件不可用';
    else if (!this.config.apiKey.trim()) structuralReason = 'Codex API key 未配置';
    else if (Boolean(this.config.modelProvider) !== Boolean(this.config.baseUrl)) structuralReason = 'Codex 自定义 Provider 配置不完整';
    else if (this.config.modelProvider && !isValidProviderId(this.config.modelProvider)) structuralReason = 'Codex Provider ID 无效';
    else if (this.config.baseUrl && !isValidApiBaseUrl(this.config.baseUrl)) structuralReason = 'Codex API 地址无效';
    else if (this.config.modelCatalogPath && (!isAbsolute(this.config.modelCatalogPath) || !existsSync(this.config.modelCatalogPath))) structuralReason = 'Codex 模型目录无效';
    else if (this.config.pythonPath && (!isAbsolute(this.config.pythonPath) || !existsSync(this.config.pythonPath))) structuralReason = 'Codex 隔离 Python 不可用';
    else if (this.config.marketDataCliPath && (!isAbsolute(this.config.marketDataCliPath) || !existsSync(this.config.marketDataCliPath))) structuralReason = 'Codex 行情只读入口不可用';
    return {
      id: this.id,
      enabled: this.config.enabled,
      available: structuralReason == null,
      reason: structuralReason ?? this.lastError,
      capabilities: this.capabilities,
    };
  }

  async start(params: ProviderStartParams, sink: ProviderEventSink): Promise<ProviderRun> {
    const health = this.health();
    if (!health.available) throw new Error(health.reason ?? 'Codex Provider 不可用');

    const executable = process.platform === 'win32' && this.config.codexPath === 'codex'
      ? 'codex.cmd'
      : this.config.codexPath;
    const command = process.platform === 'win32' && /\.cmd$/i.test(executable)
      ? process.env.ComSpec ?? 'cmd.exe'
      : executable;
    const customProviderArgs = this.config.modelProvider && this.config.baseUrl ? [
      '-c', `model_provider=${this.config.modelProvider}`,
      '-c', `model_providers.${this.config.modelProvider}.name=${this.config.modelProvider}`,
      '-c', `model_providers.${this.config.modelProvider}.base_url=${this.config.baseUrl}`,
      '-c', `model_providers.${this.config.modelProvider}.env_key=CODEX_PROVIDER_API_KEY`,
      '-c', `model_providers.${this.config.modelProvider}.wire_api=responses`,
    ] : [];
    const appServerArgs = [
      'app-server', '--stdio', ...customProviderArgs,
      ...(this.config.modelCatalogPath ? ['-c', `model_catalog_json=${this.config.modelCatalogPath}`] : []),
      '-c', 'shell_environment_policy.ignore_default_excludes=false',
      ...(this.config.sandboxMode === 'workspace-write'
        ? ['-c', `sandbox_workspace_write.network_access=${Boolean(this.config.networkEnabled)}`]
        : []),
      ...(process.platform === 'win32' && this.config.sandboxMode === 'workspace-write'
        ? ['-c', `windows.sandbox=${this.config.windowsSandbox ?? 'unelevated'}`]
        : []),
      '-c', 'web_search=disabled',
      ...(!this.config.toolsEnabled ? ['--disable', 'shell_tool'] : []),
      '--disable', 'apps',
      '--disable', 'browser_use',
      '--disable', 'computer_use',
      '--disable', 'image_generation',
      '--disable', 'plugins',
      '--disable', 'multi_agent',
    ];
    const args = process.platform === 'win32' && /\.cmd$/i.test(executable)
      ? ['/d', '/s', '/c', executable, ...appServerArgs]
      : appServerArgs;
    const child = spawn(command, args, {
      cwd: this.config.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildCodexEnvironment(
        process.env,
        this.config.codexHome,
        this.config.modelProvider ? this.config.apiKey.trim() : undefined,
        this.config.pythonPath,
      ),
    });
    this.children.add(child);

    const pending = new Map<number | string, PendingRequest>();
    let requestId = 0;
    let threadId = params.resumeSessionId ?? '';
    let turnId = '';
    let finalMessage = '';
    let settled = false;
    let resolveCompletion!: (value: ProviderCompletion) => void;
    const completion = new Promise<ProviderCompletion>(resolve => { resolveCompletion = resolve; });
    const finish = (value: ProviderCompletion) => {
      if (settled) return;
      settled = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Codex App Server 已结束'));
      }
      pending.clear();
      this.children.delete(child);
      resolveCompletion(value);
      terminateProcessTree(child);
    };

    let eventQueue = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => {
      eventQueue = eventQueue.then(work).catch(error => {
        console.error(`[Agent/Codex] event processing failed for ${params.runId}:`, error);
      });
    };
    const send = (message: RpcMessage) => {
      if (!child.stdin?.writable) throw new Error('Codex App Server stdin 不可写');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, rpcParams: Record<string, unknown>): Promise<Record<string, any>> => {
      const id = ++requestId;
      const timeoutMs = this.config.requestTimeoutMs ?? 15_000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex App Server 请求超时: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params: rpcParams });
      });
    };

    const handleNotification = async (message: RpcMessage) => {
      const rpcParams = message.params ?? {};
      if (message.method === 'turn/started') {
        turnId = String(rpcParams.turn?.id ?? turnId);
        await sink.event({ type: 'progress', publicContent: 'Codex 已启动，正在分析任务', timestamp: now() });
        return;
      }
      if (message.method === 'item/started' && isToolItem(rpcParams.item ?? {})) {
        const item = rpcParams.item as Record<string, any>;
        const toolName = publicToolName(item);
        await sink.event({
          type: 'tool_started', publicContent: `正在使用 ${toolName}`, timestamp: now(),
          toolName, toolUseId: String(item.id ?? '').slice(0, 128) || undefined,
        });
        return;
      }
      if (message.method === 'item/agentMessage/delta') {
        finalMessage += typeof rpcParams.delta === 'string' ? rpcParams.delta : '';
        return;
      }
      if (message.method === 'item/completed') {
        const item = rpcParams.item as Record<string, any> | undefined;
        if (!item) return;
        if (item.type === 'agentMessage' && typeof item.text === 'string') finalMessage = item.text;
        if (isToolItem(item)) {
          const toolName = publicToolName(item);
          const failed = ['failed', 'declined', 'error'].includes(String(item.status ?? '').toLowerCase());
          await sink.event({
            type: failed ? 'error' : 'tool_finished',
            publicContent: failed ? `${toolName} 执行失败` : `${toolName} 执行完成`,
            timestamp: now(), toolName,
            toolUseId: String(item.id ?? '').slice(0, 128) || undefined,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
          });
        }
        return;
      }
      if (message.method === 'error') {
        const content = sanitizePublicContent(rpcParams.error?.message ?? rpcParams.message, 'Codex 运行错误');
        await sink.event({ type: 'error', publicContent: content, timestamp: now() });
        return;
      }
      if (message.method === 'turn/completed') {
        const status = String(rpcParams.turn?.status ?? 'failed');
        if (status === 'completed') {
          const parsed = extractReportDirective(finalMessage);
          if (parsed.decision) await sink.reportDecision(parsed.decision.generate);
          if (parsed.answer) await sink.event({ type: 'assistant_final', publicContent: parsed.answer, timestamp: now() });
          finish({ status: 'completed', exitCode: 0 });
        } else if (status === 'interrupted') {
          finish({ status: 'interrupted', exitCode: null });
        } else {
          const errorMessage = sanitizePublicContent(rpcParams.turn?.error?.message, 'Codex turn 执行失败');
          finish({ status: 'failed', exitCode: null, errorCode: 'CODEX_TURN_FAILED', errorMessage });
        }
      }
    };

    const reader = createInterface({ input: child.stdout! });
    reader.on('line', line => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      if (message.id != null && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message ?? `JSON-RPC ${message.error.code ?? 'error'}`));
        else entry.resolve(message.result ?? {});
        return;
      }
      if (message.id != null && message.method) {
        const rpcParams = message.params ?? {};
        if (this.config.approvalsEnabled && sink.approval
          && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          enqueue(async () => {
            const isFile = message.method === 'item/fileChange/requestApproval';
            const requestType = isFile ? 'file_change' : rpcParams.networkApprovalContext ? 'network' : 'command';
            const rawSummary = isFile
              ? rpcParams.reason ?? `请求修改项目文件${rpcParams.grantRoot ? `：${rpcParams.grantRoot}` : ''}`
              : rpcParams.reason ?? rpcParams.command ?? '请求执行命令';
            let decision: 'approved' | 'denied' = 'denied';
            try {
              decision = await sink.approval!({
                threadId: String(rpcParams.threadId ?? threadId), turnId: String(rpcParams.turnId ?? turnId),
                itemId: String(rpcParams.itemId ?? rpcParams.approvalId ?? message.id), requestType,
                summary: sanitizePublicContent(rawSummary, 'Codex 请求批准操作'),
              });
            } catch {
              // Persistence/UI failures must fail closed and must not leave App Server waiting forever.
            }
            send({ id: message.id, result: { decision: decision === 'approved' ? 'accept' : 'decline' } });
          });
        } else {
          send({ id: message.id, error: { code: -32000, message: '此请求类型未启用交互式审批' } });
        }
        return;
      }
      if (message.method) enqueue(() => handleNotification(message));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = sanitizePublicContent(chunk.toString('utf8'));
      if (text) console.warn(`[Agent/Codex] ${text}`);
    });
    child.once('error', error => {
      const message = sanitizePublicContent(error.message, 'Codex App Server 启动失败');
      this.lastError = message;
      finish({ status: 'failed', exitCode: null, errorCode: 'SPAWN_ERROR', errorMessage: message });
    });
    child.once('close', exitCode => {
      if (!settled) finish({
        status: 'failed', exitCode, errorCode: 'APP_SERVER_EXIT', errorMessage: `Codex App Server 退出码 ${exitCode}`,
      });
    });

    try {
      await request('initialize', { clientInfo: { name: 'quant_backtest', title: 'Quant Backtest', version: '0.1.0' } });
      send({ method: 'initialized', params: {} });
      if (!this.config.modelProvider) {
        await request('account/login/start', { type: 'apiKey', apiKey: this.config.apiKey.trim() });
        const accountResult = await request('account/read', { refreshToken: false });
        if (accountResult.account?.type !== 'apiKey') throw new Error('Codex 未进入项目 API key 认证模式');
      }
      const threadResult = await request(params.resumeSessionId ? 'thread/resume' : 'thread/start', params.resumeSessionId
        ? {
            threadId: params.resumeSessionId, cwd: this.config.workingDirectory,
            approvalPolicy: this.approvalPolicy, sandbox: this.config.sandboxMode ?? 'read-only', ...(this.config.model ? { model: this.config.model } : {}),
          }
        : {
            cwd: this.config.workingDirectory, approvalPolicy: this.approvalPolicy, sandbox: this.config.sandboxMode ?? 'read-only',
            ephemeral: false, ...(this.config.model ? { model: this.config.model } : {}),
          });
      threadId = String(threadResult.thread?.id ?? params.resumeSessionId ?? '');
      if (!threadId) throw new Error('Codex 未返回 thread ID');
      await sink.session(threadId);
      const turnResult = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: params.prompt, text_elements: [] }],
        cwd: this.config.workingDirectory,
        approvalPolicy: this.approvalPolicy,
      });
      turnId = String(turnResult.turn?.id ?? turnId);
      this.lastError = null;
    } catch (error) {
      const message = sanitizePublicContent(error instanceof Error ? error.message : String(error), 'Codex 启动失败');
      this.lastError = message;
      finish({ status: 'failed', exitCode: null, errorCode: 'CODEX_STARTUP_ERROR', errorMessage: message });
      throw new Error(message);
    }

    return {
      pid: child.pid ?? null,
      threadId,
      completion,
      cancel: async () => {
        if (settled) return;
        const forceTimer = setTimeout(() => {
          terminateProcessTree(child);
          finish({ status: 'interrupted', exitCode: null });
        }, 5_000);
        if (threadId && turnId) {
          try { await request('turn/interrupt', { threadId, turnId }); } catch { terminateProcessTree(child); }
        } else {
          terminateProcessTree(child);
        }
        await completion;
        clearTimeout(forceTimer);
      },
    };
  }

  async shutdown(): Promise<void> {
    for (const child of this.children) terminateProcessTree(child);
    this.children.clear();
  }
}

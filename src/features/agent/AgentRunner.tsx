import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Input, Button, Typography, Tag, App, Select, Tooltip, Spin, Empty,
} from 'antd';
import {
  StopOutlined,
  PlusOutlined, SettingOutlined, ReloadOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
  SendOutlined, PaperClipOutlined, CloseOutlined, FileImageOutlined, FileTextOutlined,
  DeleteOutlined, MessageOutlined, UndoOutlined, UploadOutlined,
  DownOutlined, RightOutlined,
} from '@ant-design/icons';
import { AgentEventList, calcDuration } from './AgentEventList';
import { useAgentStream } from './useAgentStream';
import {
  createAgentRun, cancelAgentRun, listAgentConversations, deleteAgentConversation, retryAgentRun,
  continueAgentRun, getAgentConversation, getAgentProviders, decideAgentApproval,
  uploadAgentAttachment, deleteAgentAttachment,
} from './api';
import { useAgentTheme } from '@/theme';
import type {
  AgentAttachment, AgentAttachmentConfig, AgentRun, AgentEvent, AgentConversationTurn, AgentProviderHealth, AgentProviderId,
} from './types';

const { TextArea } = Input;
const { Text } = Typography;

const PROMPT_PARAM = 'prompt';
const DEFAULT_ATTACHMENT_CONFIG: AgentAttachmentConfig = {
  maxFiles: 8, maxFileMb: 20,
  accept: '.png,.jpg,.jpeg,.gif,.webp,.md,.markdown,.txt,.pdf,.doc,.docx,.docm,.rtf,.odt,.xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.ppt,.pptx,.odp',
};

interface AttachmentDraft {
  localId: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  attachment?: AgentAttachment;
  error?: string;
}

const statusColor: Record<string, string> = {
  idle: 'default',
  connecting: 'processing',
  starting: 'processing',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  canceled: 'warning',
  pending: 'default',
};

const statusText: Record<string, string> = {
  idle: '待机',
  connecting: '连接中',
  starting: '启动中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  pending: '排队中',
};

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60000) return '刚刚';
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}分钟前`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}小时前`;
    return d.toLocaleDateString('zh-CN');
  } catch {
    return '';
  }
}

function truncatePrompt(prompt: string, max = 40): string {
  const one = prompt.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '...' : one;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePastedFile(file: File): File {
  if (file.name && file.name.includes('.')) return file;
  const extension = ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/pdf': 'pdf',
  } as Record<string, string>)[file.type] ?? 'bin';
  return new File([file], `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, {
    type: file.type, lastModified: file.lastModified,
  });
}

function formatChatDate(iso?: string | null): string {
  if (!iso) {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  }
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('zh-CN', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

type DateGroup = 'today' | 'yesterday' | 'week' | 'earlier';

const GROUP_LABELS: Record<DateGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
};

function groupRunsByDate(runs: AgentRun[]): { group: DateGroup; runs: AgentRun[] }[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - (now.getDay() * 86400000);

  const buckets: Record<DateGroup, AgentRun[]> = { today: [], yesterday: [], week: [], earlier: [] };

  for (const run of runs) {
    if (!run.createdAt) {
      buckets.earlier.push(run);
      continue;
    }
    const t = new Date(run.createdAt).getTime();
    if (t >= todayStart) buckets.today.push(run);
    else if (t >= yesterdayStart) buckets.yesterday.push(run);
    else if (t >= weekStart) buckets.week.push(run);
    else buckets.earlier.push(run);
  }

  const order: DateGroup[] = ['today', 'yesterday', 'week', 'earlier'];
  return order
    .map(g => ({ group: g, runs: buckets[g] }))
    .filter(b => b.runs.length > 0);
}

function conversationEvents(turns: AgentConversationTurn[]): AgentEvent[] {
  return turns.flatMap(({ run, events, attachments }) => [
    {
      type: 'user' as const,
      content: run.prompt,
      timestamp: run.createdAt,
      runId: run.id,
      attachments: attachments ?? [],
    },
    ...events.map(event => ({ ...event, runId: event.runId ?? run.id })),
  ]);
}

function lastEventSeq(turn?: AgentConversationTurn): number {
  return turn?.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) ?? 0;
}

export default function AgentRunner() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<AgentProviderId>('claude');
  const [providers, setProviders] = useState<AgentProviderHealth[]>([]);
  const [attachmentConfig, setAttachmentConfig] = useState(DEFAULT_ATTACHMENT_CONFIG);
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pendingConversationDeletes, setPendingConversationDeletes] = useState<Set<string>>(new Set());
  const [runId, setRunId] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compactLayout, setCompactLayout] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<AgentRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [currentRunStartTime, setCurrentRunStartTime] = useState<string | null>(null);
  const [continueFromRunId, setContinueFromRunId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<DateGroup>>(new Set(['yesterday', 'week', 'earlier']));
  const { message, notification } = App.useApp();
  const { state, connect, disconnect, hydrate } = useAgentStream();
  const t = useAgentTheme();
  const inputRef = useRef<{ focus: () => void; resizableTextArea?: { textArea: HTMLTextAreaElement } } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const deleteTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const syncLayout = () => {
      setCompactLayout(media.matches);
      if (media.matches) setSidebarCollapsed(true);
    };
    syncLayout();
    media.addEventListener('change', syncLayout);
    return () => media.removeEventListener('change', syncLayout);
  }, []);

  useEffect(() => {
    let active = true;
    getAgentProviders().then(result => {
      if (!active) return;
      setProviders(result.providers);
      setAttachmentConfig(result.attachments ?? DEFAULT_ATTACHMENT_CONFIG);
      const preferred = result.providers.find(item => item.id === result.defaultProvider && item.available)
        ?? result.providers.find(item => item.available);
      if (preferred) setProvider(preferred.id);
    }).catch(() => {
      if (active) setProviders([]);
    });
    return () => { active = false; };
  }, []);

  const loadConversation = useCallback(async (id: string, selectedRunId?: string) => {
    const result = await getAgentConversation(id);
    const selectedTurn = result.turns[result.turns.length - 1];
    if (!selectedTurn) throw new Error('对话内容为空');

    setRunId(selectedRunId ?? selectedTurn.run.id);
    setCurrentConversationId(selectedTurn.run.conversationId);
    setProvider(selectedTurn.run.provider ?? 'claude');
    setCurrentPrompt('');
    setCurrentRunStartTime(result.turns[0]?.run.createdAt ?? selectedTurn.run.createdAt);
    const selectedId = selectedRunId ?? selectedTurn.run.id;
    const initialEvents = conversationEvents(result.turns);
    if (selectedTurn.run.status === 'completed' || selectedTurn.run.status === 'failed' || selectedTurn.run.status === 'canceled') {
      hydrate(selectedId, initialEvents, selectedTurn.run.status, selectedTurn.report ? {
        title: selectedTurn.report.title, summary: selectedTurn.report.summary ?? '',
      } : null);
    } else {
      connect(selectedId, { initialEvents, lastSeq: lastEventSeq(selectedTurn) });
    }
    return selectedTurn.run;
  }, [connect, hydrate]);

  // 从 URL 参数预填 prompt 或设置继续对话（支持从运行历史跳转过来）
  useEffect(() => {
    const p = searchParams.get(PROMPT_PARAM);
    if (p) {
      setPrompt(p);
      setSearchParams({}, { replace: true });
    }
    const continueId = searchParams.get('continue');
    if (continueId) {
      setContinueFromRunId(continueId);
      loadConversation(continueId).catch(() => {
        message.error('加载历史对话失败');
      });
      setSearchParams({}, { replace: true });
      inputRef.current?.focus();
    }
  }, [searchParams, setSearchParams, loadConversation, message]);

  // 加载历史会话列表
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await listAgentConversations(30);
      setHistoryRuns(result.conversations ?? []);
      setHistoryCursor(result.nextCursor);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setHistoryError(detail);
      message.error(`加载历史对话失败：${detail}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [message]);

  const loadMoreHistory = useCallback(async () => {
    if (!historyCursor || historyLoading) return;
    setHistoryLoading(true);
    try {
      const result = await listAgentConversations(30, historyCursor);
      setHistoryRuns(previous => {
        const known = new Set(previous.map(run => run.id));
        return [...previous, ...result.conversations.filter(run => !known.has(run.id))];
      });
      setHistoryCursor(result.nextCursor);
    } catch (error) {
      message.error(`加载更多历史对话失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyCursor, historyLoading, message]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // 当状态变为 completed/failed/canceled 时刷新历史列表
  useEffect(() => {
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'canceled') {
      fetchHistory();
    }
  }, [state.status, fetchHistory]);

  // 高1: 运行结束后自动进入续接模式，允许在同一界面直接继续对话
  useEffect(() => {
    if ((state.status === 'completed' || state.status === 'failed') && runId) {
      setContinueFromRunId(runId);
    }
  }, [state.status, runId]);

  const conversationRuns = historyRuns;
  const conversationTitle = useCallback((run: AgentRun) => run.rootPrompt ?? run.prompt, []);
  const groupedRuns = useMemo(() => groupRunsByDate(conversationRuns), [conversationRuns]);

  const toggleGroup = useCallback((group: DateGroup) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const handleAttachmentFiles = useCallback((files: FileList | File[] | null) => {
    if (!files?.length) return;
    const available = Math.max(0, attachmentConfig.maxFiles - attachmentDrafts.length);
    const selected = Array.from(files).slice(0, available);
    if (files.length > available) message.warning(`每轮最多上传 ${attachmentConfig.maxFiles} 个附件`);
    const drafts = selected.map(file => ({
      localId: crypto.randomUUID(), name: file.name, size: file.size, status: 'uploading' as const, file,
    }));
    setAttachmentDrafts(current => [...current, ...drafts.map(({ file: _file, ...draft }) => draft)]);
    for (const draft of drafts) {
      if (draft.file.size > attachmentConfig.maxFileMb * 1024 * 1024) {
        setAttachmentDrafts(current => current.map(item => item.localId === draft.localId
          ? { ...item, status: 'error', error: `文件不能超过 ${attachmentConfig.maxFileMb} MB` } : item));
        continue;
      }
      void uploadAgentAttachment(draft.file).then(attachment => {
        setAttachmentDrafts(current => current.map(item => item.localId === draft.localId
          ? { ...item, status: 'ready', attachment } : item));
      }).catch(error => {
        const reason = error instanceof Error ? error.message : '上传失败';
        setAttachmentDrafts(current => current.map(item => item.localId === draft.localId
          ? { ...item, status: 'error', error: reason } : item));
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [attachmentConfig, attachmentDrafts.length, message]);

  const handleAttachmentPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).map(normalizePastedFile);
    if (!files.length) return;
    event.preventDefault();
    handleAttachmentFiles(files);
  }, [handleAttachmentFiles]);

  const handleAttachmentDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setAttachmentDragActive(false);
    if (state.status === 'running' || state.status === 'connecting' || loading) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) handleAttachmentFiles(files);
  }, [handleAttachmentFiles, loading, state.status]);

  const handleRemoveAttachment = useCallback((localId: string) => {
    const selected = attachmentDrafts.find(item => item.localId === localId);
    setAttachmentDrafts(current => current.filter(item => item.localId !== localId));
    if (selected?.attachment?.id) {
      void deleteAgentAttachment(selected.attachment.id).catch(() => undefined);
    }
  }, [attachmentDrafts]);

  const clearUnboundAttachments = useCallback(() => {
    const ids = attachmentDrafts.flatMap(item => item.attachment?.id ? [item.attachment.id] : []);
    setAttachmentDrafts([]);
    for (const id of ids) void deleteAgentAttachment(id).catch(() => undefined);
  }, [attachmentDrafts]);

  const submitMessage = useCallback(async (value: string) => {
    if (attachmentDrafts.some(item => item.status === 'uploading')) {
      message.warning('附件仍在处理中，请稍候');
      return;
    }
    if (attachmentDrafts.some(item => item.status === 'error')) {
      message.warning('请移除处理失败的附件后再发送');
      return;
    }
    const readyAttachments = attachmentDrafts.flatMap(item => item.attachment ? [item.attachment] : []);
    const submittedPrompt = value.trim() || (readyAttachments.length ? '请分析附件内容。' : '');
    if (submittedPrompt.length < 1) {
      message.warning('请输入内容');
      return;
    }
    setLoading(true);
    try {
      let result: { runId: string; conversationId: string; status: string };
      const parentRunId = continueFromRunId
        ?? ((state.status === 'completed' || state.status === 'failed' || state.status === 'canceled') ? runId : null);
      const isContinue = !!parentRunId;
      const attachmentIds = readyAttachments.map(attachment => attachment.id);
      if (parentRunId) {
        result = await continueAgentRun(parentRunId, submittedPrompt, attachmentIds);
      } else {
        result = await createAgentRun(submittedPrompt, provider, attachmentIds);
      }
      setRunId(result.runId);
      setCurrentConversationId(result.conversationId);
      if (!isContinue) {
        setCurrentPrompt('');
        setCurrentRunStartTime(new Date().toISOString());
      }
      const userEvent: AgentEvent = {
        type: 'user',
        content: submittedPrompt,
        timestamp: new Date().toISOString(),
        runId: result.runId,
        attachments: readyAttachments,
      };
      connect(result.runId, {
        initialEvents: isContinue ? [...state.events, userEvent] : [userEvent],
      });
      setPrompt('');
      setAttachmentDrafts([]);
      setContinueFromRunId(null);
    } catch (err) {
      message.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [attachmentDrafts, provider, connect, message, continueFromRunId, state.events, state.status, runId]);

  const handleStart = useCallback(() => submitMessage(prompt), [prompt, submitMessage]);
  const handleConfirmation = useCallback((response: string) => {
    void submitMessage(response);
  }, [submitMessage]);
  const handleApproval = useCallback(async (approvalId: string, decision: 'approved' | 'denied') => {
    try {
      await decideAgentApproval(approvalId, decision);
      message.success(decision === 'approved' ? '已批准本次操作' : '已拒绝本次操作');
    } catch (error) {
      message.error(`审批失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [message]);

  const handleCancel = useCallback(async () => {
    if (!runId) return;
    try {
      await cancelAgentRun(runId);
      message.info('已发送取消信号');
    } catch {
      message.error('取消失败');
    }
  }, [runId, message]);

  const handleNewConversation = useCallback(() => {
    disconnect();
    clearUnboundAttachments();
    setRunId(null);
    setCurrentConversationId(null);
    setPrompt('');
    setCurrentPrompt('');
    setCurrentRunStartTime(null);
    setContinueFromRunId(null);
    inputRef.current?.focus();
  }, [disconnect, clearUnboundAttachments]);

  const undoConversationDelete = useCallback((conversationId: string) => {
    const timer = deleteTimersRef.current.get(conversationId);
    if (timer) clearTimeout(timer);
    deleteTimersRef.current.delete(conversationId);
    setPendingConversationDeletes(current => {
      const next = new Set(current); next.delete(conversationId); return next;
    });
    notification.destroy(`delete-conversation-${conversationId}`);
    message.success('已撤销删除');
  }, [message, notification]);

  const scheduleConversationDelete = useCallback((conversation: AgentRun) => {
    const conversationId = conversation.conversationId;
    if (deleteTimersRef.current.has(conversationId)) return;
    setPendingConversationDeletes(current => new Set(current).add(conversationId));
    const key = `delete-conversation-${conversationId}`;
    const timer = setTimeout(() => {
      deleteTimersRef.current.delete(conversationId);
      void deleteAgentConversation(conversationId).then(() => {
        notification.destroy(key);
        setPendingConversationDeletes(current => {
          const next = new Set(current); next.delete(conversationId); return next;
        });
        void fetchHistory();
        if (currentConversationId === conversationId) handleNewConversation();
        message.success('整段对话已删除');
      }).catch(error => {
        notification.destroy(key);
        setPendingConversationDeletes(current => {
          const next = new Set(current); next.delete(conversationId); return next;
        });
        message.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 5_000);
    deleteTimersRef.current.set(conversationId, timer);
    notification.warning({
      key,
      title: '将在 5 秒后删除整段对话',
      description: '所有轮次、附件和报告都会一起删除。',
      placement: 'bottomRight',
      duration: 5,
      showProgress: true,
      pauseOnHover: false,
      closable: false,
      actions: <Button size="small" icon={<UndoOutlined />} onClick={() => undoConversationDelete(conversationId)}>撤销删除</Button>,
    });
  }, [currentConversationId, fetchHistory, handleNewConversation, message, notification, undoConversationDelete]);

  useEffect(() => () => {
    for (const timer of deleteTimersRef.current.values()) clearTimeout(timer);
    deleteTimersRef.current.clear();
  }, []);

  const handleRetry = useCallback(async (failedRunId: string) => {
    if (retrying) return;
    setRetrying(true);
    try {
      const result = await retryAgentRun(failedRunId);
      const userEvent: AgentEvent = {
        type: 'user', content: result.prompt, timestamp: new Date().toISOString(), runId: result.runId,
      };
      setRunId(result.runId);
      setCurrentConversationId(result.conversationId);
      setContinueFromRunId(null);
      connect(result.runId, { initialEvents: [...state.events, userEvent] });
    } catch (error) {
      message.error(`重试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRetrying(false);
    }
  }, [connect, message, retrying, state.events]);

  const handleContinueRun = useCallback(async (parentRun: AgentRun) => {
    try {
      if (runId !== parentRun.id) await loadConversation(parentRun.id);
      setProvider(parentRun.provider ?? 'claude');
      setContinueFromRunId(parentRun.id);
      setPrompt('');
      inputRef.current?.focus();
    } catch {
      message.error('加载对话失败，暂时无法继续');
    }
  }, [runId, loadConversation, message]);

  // 计算步骤数和总耗时
  const stepCount = state.events.filter(e => e.type !== 'terminal').length;
  const firstEvent = state.events.find(e => e.timestamp);
  const lastEvent = [...state.events].reverse().find(e => e.timestamp);
  const totalDuration =
    firstEvent && lastEvent && firstEvent.timestamp && lastEvent.timestamp
      ? calcDuration(firstEvent.timestamp, lastEvent.timestamp)
      : '';

  const isRunning = state.status === 'running' || state.status === 'connecting';
  const attachmentsUploading = attachmentDrafts.some(item => item.status === 'uploading');
  const attachmentsFailed = attachmentDrafts.some(item => item.status === 'error');
  const hasReadyAttachment = attachmentDrafts.some(item => item.status === 'ready');
  const canSubmit = !isRunning && !loading && !attachmentsUploading && !attachmentsFailed
    && (prompt.trim().length > 0 || hasReadyAttachment);
  const isFinalized = state.status === 'completed' || state.status === 'failed' || state.status === 'canceled';
  const hasActiveRun = !!runId;
  const providerOptions = useMemo(() => providers.filter(item => item.enabled).map(item => ({
    value: item.id,
    label: item.id === 'codex' ? 'Codex' : 'Claude',
    disabled: !item.available,
    title: item.reason ?? undefined,
  })), [providers]);

  // 外层滚动容器：流式输出时自动跟随到底部；用户手动上滚则暂停跟随
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  // 高2: 程序化滚动标记，防止 smooth 滚动动画中途触发 handleScroll 误判为用户手动上滚
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    // 切换到新 run 时重置跟随状态
    if (runId !== lastRunIdRef.current) {
      lastRunIdRef.current = runId;
      followBottomRef.current = true;
    }
  }, [runId]);

  // 事件新增 → 如果处于跟随模式则平滑滚到底部
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    if (followBottomRef.current) {
      programmaticScrollRef.current = true;
      if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: isRunning ? 'smooth' : 'auto',
      });
      // smooth 滚动动画期间忽略 handleScroll，动画完成后释放标记
      programmaticScrollTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 600);
    }
  }, [state.events.length, state.events, state.reportUrl, isRunning]);

  // 用户滚动：如果距离底部 >= 40px 则视为手动回看，停止跟随
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (programmaticScrollRef.current) return;
    const el = e.currentTarget;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    followBottomRef.current = dist < 40;
  }, []);

  // 一键回到底部
  const scrollToBottomNow = useCallback(() => {
    followBottomRef.current = true;
    if (scrollContainerRef.current) {
      programmaticScrollRef.current = true;
      if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
      programmaticScrollTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 600);
    }
  }, []);

  // 当前回合的显示日期（从当前运行的 startedAt 或 currentRunStartTime 取）
  const displayDate = formatChatDate(
    state.events.find(e => e.timestamp)?.timestamp ?? currentRunStartTime
  );

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        overflow: 'hidden',
        background: t.bg,
        position: 'relative',
      }}
    >
      {/* 主对话区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
        {/* 顶部浮动工具栏（ChatGPT同款极细，右上角浮动） */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            zIndex: 10,
            display: 'flex',
            gap: 6,
          }}
        >
          <Tooltip title="刷新历史列表">
            <Button
              aria-label="刷新历史对话"
              size="small"
              type="text"
              icon={<ReloadOutlined style={{ fontSize: 15 }} />}
              onClick={fetchHistory}
              loading={historyLoading}
              style={{ color: t.textSecondary, borderRadius: 8, width: 32, height: 32 }}
            />
          </Tooltip>
          <Tooltip title={sidebarCollapsed ? '展开会话列表' : '收起会话列表'}>
            <Button
              aria-label={sidebarCollapsed ? '展开会话列表' : '收起会话列表'}
              size="small"
              type="text"
              icon={(sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />) as React.ReactElement}
              onClick={() => setSidebarCollapsed(c => !c)}
              style={{ color: t.textSecondary, borderRadius: 8, width: 32, height: 32 }}
            />
          </Tooltip>
        </div>

        {/* 对话流（ChatGPT同款：纯白带日期分隔线居中） */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '56px 20px 180px',
          }}
        >
          <div style={{ maxWidth: 768, margin: '0 auto' }}>
            {hasActiveRun && (
              <div style={{ textAlign: 'center', color: t.textSecondary, fontSize: 12, marginBottom: 18 }}>
                {displayDate}
                {stepCount > 0 && <span style={{ marginLeft: 8 }}>· {stepCount} 步</span>}
                {totalDuration && <span style={{ marginLeft: 8 }}>· {totalDuration}</span>}
                {state.status !== 'idle' && (
                  <Tag
                    color={statusColor[state.status]}
                    style={{ marginLeft: 8, fontSize: 10, borderRadius: 4 }}
                  >
                    {statusText[state.status]}
                  </Tag>
                )}
              </div>
            )}
            <AgentEventList
              events={state.events}
              userPrompt={currentPrompt}
              reportUrl={state.reportUrl}
              reportMeta={state.reportMeta}
              runId={runId}
              isStreaming={isRunning}
              autoCollapseIntermediates={isFinalized}
              onConfirm={handleConfirmation}
              confirmationDisabled={loading || isRunning}
              onApproval={(id, decision) => void handleApproval(id, decision)}
              approvalDisabled={loading}
              retryableRunId={state.status === 'failed' ? runId : null}
              onRetry={handleRetry}
              retrying={retrying}
            />
          </div>
        </div>

        {/* 跟随底部按钮（用户向上滚动查看历史时，固定在右下角显示） */}
        {!followBottomRef.current && hasActiveRun && (
          <button
            type="button"
            aria-label="回到最新消息"
            onClick={scrollToBottomNow}
            title="回到底部最新内容"
            style={{
              position: 'absolute',
              right: 28,
              bottom: 140,
              zIndex: 20,
              width: 38,
              height: 38,
              borderRadius: '50%',
              border: `1px solid ${t.border}`,
              background: t.bgCard,
              color: t.text,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              transition: 'transform 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <DownOutlined />
          </button>
        )}

        {/* 底部固定输入区（ChatGPT同款：输入框悬浮居中，大圆角内嵌按钮） */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: `linear-gradient(to top, ${t.bgGradientTop} 0%, ${t.bgGradientTop} 60%, ${t.bgGradientTop}00 100%)`,
            padding: '28px 20px 36px',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{ maxWidth: 768, margin: '0 auto', pointerEvents: 'auto' }}
            onDragEnter={event => {
              if (!isRunning && !loading && event.dataTransfer.types.includes('Files')) setAttachmentDragActive(true);
            }}
            onDragOver={event => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = isRunning || loading ? 'none' : 'copy';
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAttachmentDragActive(false);
            }}
            onDrop={handleAttachmentDrop}
          >
            {attachmentDragActive && (
              <div role="status" aria-live="polite" style={{
                minHeight: 52, marginBottom: 10, borderRadius: 14, border: `2px dashed ${t.textOnBlue}`,
                background: t.bgSelected, color: t.textOnBlue, display: 'flex', alignItems: 'center',
                justifyContent: 'center', gap: 9, fontSize: 13, fontWeight: 600,
              }}>
                <UploadOutlined />释放文件以添加附件
              </div>
            )}
            {attachmentDrafts.length > 0 && (
              <div
                role="list"
                aria-label="待发送附件"
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}
              >
                {attachmentDrafts.map(item => {
                  const image = item.attachment?.kind === 'image' || /\.(png|jpe?g|gif|webp)$/i.test(item.name);
                  return (
                    <div
                      role="listitem"
                      key={item.localId}
                      title={item.error ?? item.name}
                      style={{
                        maxWidth: '100%', minHeight: 40, display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 5px 5px 10px', borderRadius: 10,
                        border: `1px solid ${item.status === 'error' ? t.errorBorder : t.borderSubtle}`,
                        background: item.status === 'error' ? t.errorBg : t.bgSubtle,
                        color: item.status === 'error' ? t.errorText : t.text,
                      }}
                    >
                      {item.status === 'uploading'
                        ? <Spin size="small" />
                        : image ? <FileImageOutlined /> : <FileTextOutlined />}
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {item.name}
                        </span>
                        <span style={{ display: 'block', color: t.textSecondary, fontSize: 10 }}>
                          {item.status === 'uploading' ? '正在解析' : item.status === 'error' ? item.error : formatFileSize(item.size)}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`移除附件 ${item.name}`}
                        onClick={() => handleRemoveAttachment(item.localId)}
                        style={{ width: 32, height: 32, border: 0, borderRadius: 8, background: 'transparent', color: t.textSecondary, cursor: 'pointer' }}
                      >
                        <CloseOutlined />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Provider 选择面板（悬浮在输入框上方） */}
            {showSettings && (
              <div
                style={{
                  marginBottom: 10,
                  background: t.bgSubtle,
                  border: `1px solid ${t.borderSubtle}`,
                  borderRadius: 14,
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <label htmlFor="agent-provider-select" style={{ color: t.textSecondary, fontSize: 12 }}>
                  Provider：
                </label>
                <Select
                  id="agent-provider-select"
                  aria-label="选择 Provider"
                  size="small"
                  value={provider}
                  onChange={(value: AgentProviderId) => setProvider(value)}
                  options={providerOptions}
                  style={{ width: 140 }}
                  disabled={isRunning || Boolean(continueFromRunId) || providerOptions.length === 0}
                />
              </div>
            )}

            {/* 主输入框（ChatGPT同款圆角胶囊） */}
            <div
              style={{
                background: t.bgInput,
                border: `1px solid ${t.border}`,
                borderRadius: 24,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.02), 0 2px 6px rgba(0,0,0,0.03)',
                padding: '8px 8px 8px 16px',
                display: 'flex',
                alignItems: 'flex-end',
                gap: 6,
                transition: 'box-shadow 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 0 0 1px rgba(26,115,232,0.15), 0 4px 12px rgba(0,0,0,0.05)';
                e.currentTarget.style.borderColor = t.textOnBlue;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.02), 0 2px 6px rgba(0,0,0,0.03)';
                e.currentTarget.style.borderColor = t.border;
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={attachmentConfig.accept}
                aria-label="选择附件文件"
                onChange={event => handleAttachmentFiles(event.target.files)}
                style={{ display: 'none' }}
              />
              <Tooltip title="添加附件，也可拖入文件或按 Ctrl+V 粘贴">
                <button
                  type="button"
                  aria-label="添加附件"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRunning || loading || attachmentDrafts.length >= attachmentConfig.maxFiles}
                  style={{
                    width: 44, height: 44, padding: 0, border: 0, borderRadius: '50%',
                    background: 'transparent', color: t.textSecondary,
                    cursor: isRunning || loading || attachmentDrafts.length >= attachmentConfig.maxFiles ? 'not-allowed' : 'pointer',
                    opacity: isRunning || loading || attachmentDrafts.length >= attachmentConfig.maxFiles ? .45 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                  onMouseEnter={event => { if (!event.currentTarget.disabled) event.currentTarget.style.background = t.bgHover; }}
                  onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <PaperClipOutlined style={{ fontSize: 17 }} />
                </button>
              </Tooltip>

              {/* 左侧 Provider 设置按钮 */}
              <Tooltip title={showSettings ? '收起 Provider 设置' : '选择 Provider'}>
                <button
                  type="button"
                  aria-label={showSettings ? '收起 Provider 设置' : '打开 Provider 设置'}
                  aria-expanded={showSettings}
                  onClick={() => setShowSettings(s => !s)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    color: showSettings ? t.textOnBlue : t.textSecondary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = t.bgHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <SettingOutlined style={{ fontSize: 17 }} />
                </button>
              </Tooltip>

              <TextArea
                aria-label="对话消息"
                ref={inputRef as never}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={handleAttachmentPaste}
                placeholder={
                  isRunning
                    ? 'Agent 运行中…'
                    : continueFromRunId
                    ? '输入继续指令，万行智研将接着上次对话工作…'
                    : '向万行智研提问，或描述你的策略研究需求…'
                }
                autoSize={{ minRows: 1, maxRows: 8 }}
                disabled={isRunning}
                onPressEnter={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    if (!isRunning) handleStart();
                  }
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  boxShadow: 'none',
                  outline: 'none',
                  resize: 'none',
                  fontSize: 15,
                  lineHeight: 1.6,
                  padding: '8px 4px',
                  flex: 1,
                }}
              />

              {/* 右侧发送按钮（ChatGPT同款圆黑按钮） */}
              {isRunning ? (
                <Tooltip title="停止运行">
                  <button
                    type="button"
                    aria-label="停止运行"
                    onClick={handleCancel}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: t.bgHover,
                      border: 'none',
                      cursor: 'pointer',
                      color: t.text,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 4,
                      flexShrink: 0,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = t.border; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = t.bgHover; }}
                  >
                    <StopOutlined style={{ fontSize: 13 }} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip title={attachmentsUploading ? '附件正在解析' : canSubmit ? '发送 (Ctrl+Enter)' : '请输入内容或添加附件'}>
                  <button
                    type="button"
                    aria-label="发送消息"
                    onClick={handleStart}
                    disabled={!canSubmit}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: canSubmit ? '#1f2937' : t.bgHover,
                      border: 'none',
                      cursor: canSubmit ? 'pointer' : 'not-allowed',
                      color: canSubmit ? '#ffffff' : t.textMuted,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 4,
                      flexShrink: 0,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (canSubmit) e.currentTarget.style.background = '#111827';
                    }}
                    onMouseLeave={(e) => {
                      if (canSubmit) e.currentTarget.style.background = '#1f2937';
                    }}
                  >
                    <SendOutlined style={{ fontSize: 13, marginLeft: 1 }} />
                  </button>
                </Tooltip>
              )}
            </div>

            {!showSettings && !isRunning && (
              <div style={{ textAlign: 'center', marginTop: 10, color: t.textSecondary, fontSize: 11 }}>
                {compactLayout
                  ? 'Ctrl + Enter 发送 · 可拖入或 Ctrl+V 添加附件'
                  : '按 Ctrl + Enter 发送 · 拖入文件或 Ctrl+V 可添加附件'}
              </div>
            )}
          </div>
        </div>
      </div>

      {compactLayout && !sidebarCollapsed && (
        <button
          type="button"
          aria-label="关闭会话列表"
          onClick={() => setSidebarCollapsed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 25,
            border: 0,
            padding: 0,
            background: 'rgba(2, 6, 23, 0.36)',
            cursor: 'pointer',
          }}
        />
      )}

      {/* 右侧会话列表栏；窄屏时作为抽屉覆盖，不挤压对话正文。 */}
      <div
        style={{
          width: sidebarCollapsed ? 0 : compactLayout ? 'min(280px, calc(100% - 16px))' : 260,
          position: compactLayout ? 'absolute' : 'relative',
          top: compactLayout ? 0 : undefined,
          right: compactLayout ? 0 : undefined,
          bottom: compactLayout ? 0 : undefined,
          zIndex: compactLayout ? 30 : undefined,
          borderLeft: sidebarCollapsed ? 'none' : `1px solid ${t.borderSubtle}`,
          background: t.bgSubtle,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflow: 'hidden',
          boxShadow: compactLayout && !sidebarCollapsed ? '-16px 0 40px rgba(0, 0, 0, 0.22)' : 'none',
          transition: 'width 0.2s cubic-bezier(0.2, 0, 0, 1), border-left-color 0.2s',
        }}
      >
          <div style={{ padding: 12, borderBottom: `1px solid ${t.borderSubtle}` }}>
            <Button
              aria-label="新建对话"
              type="primary"
              icon={<PlusOutlined />}
              block
              onClick={handleNewConversation}
              style={{ borderRadius: 10, height: 38, background: '#1a73e8' }}
            >
              新建对话
            </Button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
            {historyLoading && (
              <div style={{ textAlign: 'center', padding: 16 }}>
                <Spin size="small" />
              </div>
            )}
            {!historyLoading && historyError && (
              <div role="alert" style={{ padding: 16, textAlign: 'center', color: t.errorText }}>
                <div style={{ marginBottom: 8 }}>历史对话加载失败</div>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void fetchHistory()}>重试</Button>
              </div>
            )}
            {!historyLoading && !historyError && conversationRuns.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: t.textMuted }}>
                <Empty description="暂无历史对话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            )}
            {groupedRuns.map(({ group, runs }) => {
              const isCollapsed = collapsedGroups.has(group);
              return (
                <div key={group} style={{ marginBottom: 2 }}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(group)}
                    onKeyDown={(e) => { if (e.key === 'Enter') toggleGroup(group); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '8px 10px',
                      cursor: 'pointer',
                      borderRadius: 6,
                      fontSize: 12,
                      color: t.textSecondary,
                      fontWeight: 500,
                      userSelect: 'none',
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = t.bgHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {isCollapsed
                      ? <RightOutlined style={{ fontSize: 10, color: t.textMuted }} />
                      : <DownOutlined style={{ fontSize: 10, color: t.textMuted }} />
                    }
                    <span style={{ flex: 1 }}>{GROUP_LABELS[group]}</span>
                    <span style={{ fontSize: 11, color: t.textMuted }}>{runs.length}</span>
                  </div>
                  {!isCollapsed && (
                    <div style={{ overflow: 'hidden' }}>
                      {runs.map(run => (
                        <div
                          key={run.id}
                          onClick={() => {
                            loadConversation(run.conversationId, run.id).catch(() => {
                              message.error('加载对话失败');
                            });
                          }}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderRadius: 8,
                            marginBottom: 1,
                            background: runId === run.id ? t.bgSelected : 'transparent',
                            borderLeft: runId === run.id ? `2px solid ${t.textOnBlue}` : '2px solid transparent',
                            transition: 'background 0.15s, border-color 0.15s',
                            position: 'relative',
                          }}
                          onMouseEnter={e => {
                            if (runId !== run.id) e.currentTarget.style.background = t.bgHover;
                          }}
                          onMouseLeave={e => {
                            if (runId !== run.id) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                            <Tag color={statusColor[run.status]} style={{ margin: 0, fontSize: 10, borderRadius: 4 }}>
                              {statusText[run.status] ?? run.status}
                            </Tag>
                            <Tag color={run.provider === 'codex' ? 'geekblue' : 'purple'} style={{ margin: 0, fontSize: 10, borderRadius: 4 }}>
                              {run.provider === 'codex' ? 'Codex' : 'Claude'}
                            </Tag>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {formatRelativeTime(run.createdAt)}
                            </Text>
                            <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                              {(run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') && (
                                <Tooltip title="继续对话">
                                  <Button
                                    aria-label="继续此对话"
                                    size="small"
                                    type="text"
                                    icon={<MessageOutlined style={{ fontSize: 12 }} />}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleContinueRun(run);
                                    }}
                                    style={{ width: 22, height: 22, minWidth: 22, color: t.textOnBlue }}
                                  />
                                </Tooltip>
                              )}
                              <Tooltip title="删除整段对话">
                                <Button
                                  aria-label="删除整段对话"
                                  size="small"
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                                  loading={pendingConversationDeletes.has(run.conversationId)}
                                  disabled={pendingConversationDeletes.has(run.conversationId)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    scheduleConversationDelete(run);
                                  }}
                                  style={{ width: 22, height: 22, minWidth: 22 }}
                                />
                              </Tooltip>
                            </div>
                          </div>
                          <Text
                            style={{
                              fontSize: 13,
                              color: t.text,
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              lineHeight: 1.45,
                            }}
                          >
                            {truncatePrompt(conversationTitle(run))}
                          </Text>
                          {continueFromRunId === run.id && (
                            <div style={{ marginTop: 4, fontSize: 11, color: t.textOnBlue }}>
                              继续此对话中…
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {!historyLoading && historyCursor && (
              <Button type="text" block onClick={() => void loadMoreHistory()} style={{ margin: '8px 0' }}>
                加载更多
              </Button>
            )}
          </div>
      </div>
    </div>
  );
}

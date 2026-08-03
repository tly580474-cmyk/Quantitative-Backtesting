import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Input, Button, Typography, Tag, App, InputNumber, Select, Tooltip, Spin, Empty, Dropdown, type MenuProps,
} from 'antd';
import {
  StopOutlined, HistoryOutlined,
  PlusOutlined, SettingOutlined, ReloadOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
  SendOutlined, PaperClipOutlined,
  DeleteOutlined, MessageOutlined,
} from '@ant-design/icons';
import { AgentEventList, calcDuration } from './AgentEventList';
import { useAgentStream } from './useAgentStream';
import { createAgentRun, cancelAgentRun, listAgentRuns, deleteAgentRun, continueAgentRun, getAgentRun } from './api';
import type { AgentRun, AgentEvent } from './types';

const { TextArea } = Input;
const { Text } = Typography;

const PROMPT_PARAM = 'prompt';

const statusColor: Record<string, string> = {
  idle: 'default',
  connecting: 'processing',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  canceled: 'warning',
  pending: 'default',
};

const statusText: Record<string, string> = {
  idle: '待机',
  connecting: '连接中',
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

export default function AgentRunner() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [maxTurns, setMaxTurns] = useState(0);
  const [templateStyle, setTemplateStyle] = useState<string>('classic-blue');
  const [runId, setRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<AgentRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [currentRunStartTime, setCurrentRunStartTime] = useState<string | null>(null);
  const [continueFromRunId, setContinueFromRunId] = useState<string | null>(null);
  const { message } = App.useApp();
  const { state, connect, disconnect, pushUserMessage } = useAgentStream();
  const inputRef = useRef<{ focus: () => void; resizableTextArea?: { textArea: HTMLTextAreaElement } } | null>(null);

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
      setRunId(continueId);
      // 加载历史对话内容
      getAgentRun(continueId).then(result => {
        setCurrentPrompt(result.run?.prompt ?? '');
        setCurrentRunStartTime(result.run?.createdAt ?? null);
      }).catch(() => {});
      connect(continueId);
      setSearchParams({}, { replace: true });
      inputRef.current?.focus();
    }
  }, [searchParams, setSearchParams, connect]);

  // 加载历史会话列表
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await listAgentRuns(30, 0);
      setHistoryRuns(result.runs ?? []);
    } catch {
      // ignore
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // 当状态变为 completed/failed/canceled 时刷新历史列表
  useEffect(() => {
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'canceled') {
      fetchHistory();
    }
  }, [state.status, fetchHistory]);

  const handleStart = useCallback(async () => {
    if (prompt.trim().length < 1) {
      message.warning('请输入内容');
      return;
    }
    setLoading(true);
    try {
      let result: { runId: string; status: string };
      const isContinue = !!continueFromRunId;
      if (isContinue) {
        result = await continueAgentRun(continueFromRunId, prompt, maxTurns, undefined, templateStyle);
        // 在当前事件流中插入用户消息气泡
        pushUserMessage(prompt);
      } else {
        result = await createAgentRun(prompt, maxTurns, undefined, templateStyle);
      }
      setRunId(result.runId);
      if (!isContinue) {
        setCurrentPrompt(prompt);
      }
      setCurrentRunStartTime(new Date().toISOString());
      // 继续对话时保留已有事件（历史记录），新事件会追加
      connect(result.runId, { keepEvents: isContinue });
      setPrompt('');
      setContinueFromRunId(null);
    } catch (err) {
      message.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [prompt, maxTurns, templateStyle, connect, message, continueFromRunId, pushUserMessage]);

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
    setRunId(null);
    setPrompt('');
    setCurrentPrompt('');
    setCurrentRunStartTime(null);
    setContinueFromRunId(null);
    inputRef.current?.focus();
  }, [disconnect]);

  const handleDeleteRun = useCallback(async (id: string) => {
    try {
      await deleteAgentRun(id);
      message.success('已删除');
      fetchHistory();
      if (runId === id) {
        handleNewConversation();
      }
    } catch (err) {
      message.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [runId, fetchHistory, handleNewConversation, message]);

  const handleContinueRun = useCallback((parentRun: AgentRun) => {
    // 如果不是当前正在查看的对话，先切换到该对话
    if (runId !== parentRun.id) {
      setRunId(parentRun.id);
      setCurrentPrompt(parentRun.prompt);
      setCurrentRunStartTime(parentRun.createdAt);
      connect(parentRun.id);
    }
    // 设置继续对话模式，保留当前对话记录
    setContinueFromRunId(parentRun.id);
    setPrompt('');
    inputRef.current?.focus();
  }, [runId, connect]);

  // 历史会话上下文菜单操作
  const historyMenuItems: MenuProps['items'] = [
    {
      key: 'rerun',
      label: '重新发起',
      icon: <ReloadOutlined />,
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
      },
    },
    {
      key: 'goto-history',
      label: '查看全部历史',
      icon: <HistoryOutlined />,
      onClick: () => navigate('/agent-runs'),
    },
  ];

  // 计算步骤数和总耗时
  const stepCount = state.events.filter(e => e.type !== 'done').length;
  const firstEvent = state.events.find(e => e.timestamp);
  const lastEvent = [...state.events].reverse().find(e => e.timestamp);
  const totalDuration =
    firstEvent && lastEvent && firstEvent.timestamp && lastEvent.timestamp
      ? calcDuration(firstEvent.timestamp, lastEvent.timestamp)
      : '';

  const isRunning = state.status === 'running' || state.status === 'connecting';
  const hasActiveRun = !!runId;

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
        background: '#ffffff',
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
              size="small"
              type="text"
              icon={<ReloadOutlined style={{ fontSize: 15 }} />}
              onClick={fetchHistory}
              loading={historyLoading}
              style={{ color: '#8e8ea0', borderRadius: 8, width: 32, height: 32 }}
            />
          </Tooltip>
          <Tooltip title={sidebarCollapsed ? '展开会话列表' : '收起会话列表'}>
            <Button
              size="small"
              type="text"
              icon={(sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />) as React.ReactElement}
              onClick={() => setSidebarCollapsed(c => !c)}
              style={{ color: '#8e8ea0', borderRadius: 8, width: 32, height: 32 }}
            />
          </Tooltip>
        </div>

        {/* 对话流（ChatGPT同款：纯白带日期分隔线居中） */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '56px 20px 180px',
            scrollBehavior: 'smooth',
          }}
        >
          <div style={{ maxWidth: 768, margin: '0 auto' }}>
            {hasActiveRun && (
              <div style={{ textAlign: 'center', color: '#8e8ea0', fontSize: 12, marginBottom: 18 }}>
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
            />
          </div>
        </div>

        {/* 底部固定输入区（ChatGPT同款：输入框悬浮居中，大圆角内嵌按钮） */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(to top, #ffffff 0%, #ffffff 60%, rgba(255,255,255,0) 100%)',
            padding: '28px 20px 36px',
            pointerEvents: 'none',
          }}
        >
          <div style={{ maxWidth: 768, margin: '0 auto', pointerEvents: 'auto' }}>
            {/* 设置面板（悬浮在输入框上方） */}
            {showSettings && (
              <div
                style={{
                  marginBottom: 10,
                  background: '#f9fafb',
                  border: '1px solid #f0f0f0',
                  borderRadius: 14,
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>最大轮次：</Text>
                <InputNumber
                  size="small"
                  value={maxTurns}
                  onChange={(v) => setMaxTurns(v ?? 0)}
                  min={0}
                  max={200}
                  style={{ width: 80 }}
                  disabled={isRunning}
                  placeholder="0=不限制"
                />
                {maxTurns === 0 && (
                  <Text type="secondary" style={{ fontSize: 11, color: '#10b981' }}>不限制</Text>
                )}
                <Text type="secondary" style={{ fontSize: 12 }}>报告风格：</Text>
                <Select
                  size="small"
                  value={templateStyle}
                  onChange={(v) => setTemplateStyle(v)}
                  style={{ width: 140 }}
                  disabled={isRunning}
                  options={[
                    { value: 'classic-blue', label: '经典金融蓝' },
                    { value: 'dark-pro', label: '暗黑专业版' },
                    { value: 'minimal-white', label: '极简白' },
                    { value: 'dashboard', label: '数据仪表盘' },
                  ]}
                />
              </div>
            )}

            {/* 主输入框（ChatGPT同款圆角胶囊） */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid #e5e7eb',
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
                e.currentTarget.style.borderColor = '#d2d4db';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.02), 0 2px 6px rgba(0,0,0,0.03)';
                e.currentTarget.style.borderColor = '#e5e7eb';
              }}
            >
              {/* 左侧设置按钮（ChatGPT同款附件图标位置） */}
              <Tooltip title={showSettings ? '收起配置' : '高级配置'}>
                <button
                  onClick={() => setShowSettings(s => !s)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 6,
                    borderRadius: '50%',
                    color: showSettings ? '#1a73e8' : '#8e8ea0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 6,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {showSettings ? <SettingOutlined style={{ fontSize: 16 }} /> : <PaperClipOutlined style={{ fontSize: 16 }} />}
                </button>
              </Tooltip>

              <TextArea
                ref={inputRef as never}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  isRunning
                    ? 'Agent 运行中…'
                    : continueFromRunId
                    ? '输入继续指令，Agent 将接着上次对话工作…'
                    : '向智能体提问，或描述你的策略研究需求…'
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
                    onClick={handleCancel}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: '#f0f0f0',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#1f2937',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 4,
                      flexShrink: 0,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#e5e7eb'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '#f0f0f0'; }}
                  >
                    <StopOutlined style={{ fontSize: 13 }} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip title={prompt.trim().length < 1 ? '请输入内容' : '发送 (Ctrl+Enter)'}>
                  <button
                    onClick={handleStart}
                    disabled={prompt.trim().length < 1 || loading}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: prompt.trim().length >= 1 && !loading ? '#1f2937' : '#f0f0f0',
                      border: 'none',
                      cursor: prompt.trim().length >= 1 && !loading ? 'pointer' : 'not-allowed',
                      color: prompt.trim().length >= 1 && !loading ? '#ffffff' : '#c9ccd3',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 4,
                      flexShrink: 0,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (prompt.trim().length >= 1 && !loading) e.currentTarget.style.background = '#111827';
                    }}
                    onMouseLeave={(e) => {
                      if (prompt.trim().length >= 1 && !loading) e.currentTarget.style.background = '#1f2937';
                    }}
                  >
                    <SendOutlined style={{ fontSize: 13, marginLeft: 1 }} />
                  </button>
                </Tooltip>
              )}
            </div>

            {!showSettings && !isRunning && (
              <div style={{ textAlign: 'center', marginTop: 10, color: '#8e8ea0', fontSize: 11 }}>
                按 Ctrl + Enter 发送 · 点击左侧附件图标配置轮次与报告风格 · 0=不限轮次
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 右侧会话列表栏（可折叠） */}
      {!sidebarCollapsed && (
        <div
          style={{
            width: 260,
            borderLeft: '1px solid #ececf1',
            background: '#fafafa',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
          }}
        >
          <div style={{ padding: 12, borderBottom: '1px solid #ececf1' }}>
            <Button
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
            {!historyLoading && historyRuns.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: '#86868b' }}>
                <Empty description="暂无历史对话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            )}
            {historyRuns.map(run => (
              <div
                key={run.id}
                onClick={() => {
                  setRunId(run.id);
                  setCurrentPrompt(run.prompt);
                  setCurrentRunStartTime(run.createdAt);
                  connect(run.id);
                }}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderRadius: 8,
                  marginBottom: 2,
                  background: runId === run.id ? '#e6f0ff' : 'transparent',
                  transition: 'background 0.12s',
                  position: 'relative',
                }}
                onMouseEnter={e => {
                  if (runId !== run.id) e.currentTarget.style.background = '#f0f0f0';
                }}
                onMouseLeave={e => {
                  if (runId !== run.id) e.currentTarget.style.background = 'transparent';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Tag color={statusColor[run.status]} style={{ margin: 0, fontSize: 10, borderRadius: 4 }}>
                    {statusText[run.status] ?? run.status}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {formatRelativeTime(run.createdAt)}
                  </Text>
                  {/* 操作按钮（悬浮显示） */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                    {(run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') && (
                      <Tooltip title="继续对话">
                        <Button
                          size="small"
                          type="text"
                          icon={<MessageOutlined style={{ fontSize: 12 }} />}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleContinueRun(run);
                          }}
                          style={{ width: 22, height: 22, minWidth: 22, color: '#1a73e8' }}
                        />
                      </Tooltip>
                    )}
                    <Tooltip title="删除">
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRun(run.id);
                        }}
                        style={{ width: 22, height: 22, minWidth: 22 }}
                      />
                    </Tooltip>
                  </div>
                </div>
                <Text
                  style={{
                    fontSize: 13,
                    color: '#595959',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    lineHeight: 1.45,
                  }}
                >
                  {truncatePrompt(run.prompt)}
                </Text>
                {continueFromRunId === run.id && (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#1a73e8' }}>
                    继续此对话中…
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ padding: 8, borderTop: '1px solid #ececf1' }}>
            <Dropdown menu={{ items: historyMenuItems }} placement="topLeft">
              <Button size="small" block icon={<HistoryOutlined />} style={{ borderRadius: 8 }}>
                运行历史
              </Button>
            </Dropdown>
          </div>
        </div>
      )}
    </div>
  );
}

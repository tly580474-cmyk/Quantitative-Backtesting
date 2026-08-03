import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Input, Button, Typography, Tag, App, InputNumber, Select, Tooltip, Spin, Empty, Dropdown, type MenuProps,
} from 'antd';
import {
  PlayCircleOutlined, StopOutlined, RobotOutlined, HistoryOutlined,
  PlusOutlined, SettingOutlined, UserOutlined, ReloadOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
} from '@ant-design/icons';
import { AgentEventList, calcDuration } from './AgentEventList';
import { useAgentStream } from './useAgentStream';
import { createAgentRun, cancelAgentRun, listAgentRuns } from './api';
import type { AgentRun } from './types';

const { TextArea } = Input;
const { Text, Title } = Typography;

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

export default function AgentRunner() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [maxTurns, setMaxTurns] = useState(50);
  const [templateStyle, setTemplateStyle] = useState<string>('classic-blue');
  const [runId, setRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<AgentRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [currentPrompt, setCurrentPrompt] = useState(''); // 已提交的 prompt，用于显示用户消息
  const { message } = App.useApp();
  const { state, connect, disconnect } = useAgentStream();
  const inputRef = useRef<{ focus: () => void; resizableTextArea?: { textArea: HTMLTextAreaElement } } | null>(null);

  // 从 URL 参数预填 prompt（支持从运行历史"重新发起"跳转过来）
  useEffect(() => {
    const p = searchParams.get(PROMPT_PARAM);
    if (p) {
      setPrompt(p);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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
    if (prompt.trim().length < 10) {
      message.warning('请输入至少 10 个字符的策略描述');
      return;
    }
    setLoading(true);
    try {
      const result = await createAgentRun(prompt, maxTurns, undefined, templateStyle);
      setRunId(result.runId);
      setCurrentPrompt(prompt);
      connect(result.runId);
      setPrompt('');
      message.success('Agent 已启动');
    } catch (err) {
      message.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [prompt, maxTurns, templateStyle, connect, message]);

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
    inputRef.current?.focus();
  }, [disconnect]);

  // 历史会话上下文菜单操作
  const historyMenuItems: MenuProps['items'] = [
    {
      key: 'rerun',
      label: '重新发起',
      icon: <ReloadOutlined />,
      onClick: ({ domEvent }) => {
        // 由具体项 onClick 处理，这里空实现避免覆盖
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

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      {/* 主对话区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 顶部状态栏 */}
        <div
          style={{
            padding: '10px 20px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: '#fff',
            flexShrink: 0,
          }}
        >
          <RobotOutlined style={{ fontSize: 18, color: '#1a73e8' }} />
          <Title level={5} style={{ margin: 0 }}>策略研究智能体</Title>
          {state.status !== 'idle' && (
            <Tag color={statusColor[state.status]}>{statusText[state.status]}</Tag>
          )}
          {stepCount > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>{stepCount} 步</Text>
          )}
          {totalDuration && (
            <Text type="secondary" style={{ fontSize: 12, color: '#1a73e8' }}>
              耗时 {totalDuration}
            </Text>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Tooltip title="刷新历史列表">
              <Button size="small" icon={<ReloadOutlined />} onClick={fetchHistory} loading={historyLoading} />
            </Tooltip>
            <Tooltip title={sidebarCollapsed ? '展开会话列表' : '收起会话列表'}>
              <Button
                size="small"
                icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setSidebarCollapsed(c => !c)}
              />
            </Tooltip>
          </div>
        </div>

        {/* 对话流 */}
        <div style={{ flex: 1, minHeight: 0, background: '#fff' }}>
          <AgentEventList
            events={state.events}
            userPrompt={currentPrompt}
            reportUrl={state.reportUrl}
            reportMeta={state.reportMeta}
            runId={runId}
          />
        </div>

        {/* 底部输入区 */}
        <div
          style={{
            borderTop: '1px solid #f0f0f0',
            padding: '12px 20px 16px',
            background: '#fff',
            flexShrink: 0,
          }}
        >
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            <TextArea
              ref={inputRef as never}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                isRunning
                  ? 'Agent 运行中，输入框已锁定...'
                  : '描述你的策略研究需求，按 Ctrl+Enter 发送。例如：\n分析动量因子（momentum_20）在 2025 年 5-6 月的有效性，计算 IC、ICIR 和分层收益...'
              }
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={isRunning}
              onPressEnter={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  if (!isRunning) handleStart();
                }
              }}
              style={{ borderRadius: 12, padding: '10px 14px', fontSize: 14 }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Tooltip title="高级设置">
                  <Button
                    size="small"
                    type="text"
                    icon={<SettingOutlined />}
                    onClick={() => setShowSettings(s => !s)}
                    style={{ color: showSettings ? '#1a73e8' : undefined }}
                  />
                </Tooltip>
                {showSettings && (
                  <>
                    <Text type="secondary" style={{ fontSize: 12 }}>轮次:</Text>
                    <InputNumber
                      size="small"
                      value={maxTurns}
                      onChange={(v) => setMaxTurns(v ?? 50)}
                      min={1}
                      max={200}
                      style={{ width: 70 }}
                      disabled={isRunning}
                    />
                    <Text type="secondary" style={{ fontSize: 12 }}>风格:</Text>
                    <Select
                      size="small"
                      value={templateStyle}
                      onChange={(v) => setTemplateStyle(v)}
                      style={{ width: 130 }}
                      disabled={isRunning}
                      options={[
                        { value: 'classic-blue', label: '经典金融蓝' },
                        { value: 'dark-pro', label: '暗黑专业版' },
                        { value: 'minimal-white', label: '极简白' },
                        { value: 'dashboard', label: '数据仪表盘' },
                      ]}
                    />
                  </>
                )}
                {!showSettings && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {isRunning ? '' : 'Ctrl+Enter 发送 · 点击齿轮配置'}
                  </Text>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {isRunning ? (
                  <>
                    <Button danger icon={<StopOutlined />} onClick={handleCancel}>
                      取消运行
                    </Button>
                    <Button onClick={handleNewConversation}>新建对话</Button>
                  </>
                ) : (
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    onClick={handleStart}
                    loading={loading}
                    disabled={prompt.trim().length < 10}
                  >
                    发送
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 右侧会话列表栏（可折叠） */}
      {!sidebarCollapsed && (
        <div
          style={{
            width: 260,
            borderLeft: '1px solid #f0f0f0',
            background: '#fafafa',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
          }}
        >
          <div style={{ padding: 12, borderBottom: '1px solid #f0f0f0' }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              block
              onClick={handleNewConversation}
            >
              新建对话
            </Button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
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
                  connect(run.id);
                }}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #f0f0f0',
                  background: runId === run.id ? '#e6f0ff' : 'transparent',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => {
                  if (runId !== run.id) e.currentTarget.style.background = '#f0f0f0';
                }}
                onMouseLeave={e => {
                  if (runId !== run.id) e.currentTarget.style.background = 'transparent';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Tag color={statusColor[run.status]} style={{ margin: 0, fontSize: 10 }}>
                    {statusText[run.status] ?? run.status}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {formatRelativeTime(run.createdAt)}
                  </Text>
                </div>
                <Text
                  style={{ fontSize: 12, color: '#595959', display: 'block' }}
                  ellipsis
                >
                  {truncatePrompt(run.prompt)}
                </Text>
              </div>
            ))}
          </div>
          <div style={{ padding: 8, borderTop: '1px solid #f0f0f0' }}>
            <Dropdown menu={{ items: historyMenuItems }} placement="topLeft">
              <Button size="small" block icon={<HistoryOutlined />}>
                运行历史
              </Button>
            </Dropdown>
          </div>
        </div>
      )}
    </div>
  );
}

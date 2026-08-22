import { useEffect, useId, useState } from 'react';
import { CheckCircleOutlined, CloseCircleOutlined, CodeOutlined, DownOutlined, LoadingOutlined, RightOutlined, SafetyCertificateOutlined, UserOutlined, WarningOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentTheme } from '@/theme';
import type { AgentEvent } from './types';
import { AgentReportView } from './AgentReportView';
import { AgentConfirmationCard } from './AgentConfirmationCard';

export function calcDuration(from?: string, to?: string): string {
  if (!from || !to) return '';
  const diff = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  if (diff < 1_000) return `${diff}ms`;
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}秒`;
  return `${Math.floor(diff / 60_000)}分${Math.floor((diff % 60_000) / 1_000)}秒`;
}

function Fold({ label, children, openWhileRunning, instanceKey }: {
  label: string; children: React.ReactNode; openWhileRunning: boolean; instanceKey: string;
}) {
  const theme = useAgentTheme();
  const [open, setOpen] = useState(openWhileRunning);
  const contentId = useId();
  useEffect(() => setOpen(openWhileRunning), [openWhileRunning, instanceKey]);
  return <div style={{ borderBottom: `1px solid ${theme.borderSubtle}`, marginBottom: 12 }}>
    <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}
      style={{ minHeight: 42, width: '100%', border: 0, padding: '6px 2px', background: 'transparent', cursor: 'pointer',
        display: 'flex', alignItems: 'center', color: theme.textSecondary, textAlign: 'left' }}>
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
      {open ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
    </button>
    {open && <div id={contentId} style={{ padding: '2px 4px 12px' }}>{children}</div>}
  </div>;
}

function UserBubble({ text }: { text: string }) {
  const theme = useAgentTheme();
  return <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, margin: '18px 0 24px' }}>
    <div style={{ maxWidth: '76%', padding: '10px 16px', borderRadius: '18px 18px 4px 18px',
      background: theme.bgUserBubble, color: theme.text, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{text}</div>
    <div style={{ width: 30, height: 30, borderRadius: '50%', background: theme.bgHover, color: theme.textSecondary,
      display: 'grid', placeItems: 'center', alignSelf: 'flex-end' }}><UserOutlined /></div>
  </div>;
}

function AssistantAvatar() {
  return <div aria-hidden style={{ width: 30, height: 30, borderRadius: 9, background: '#1a73e8', color: '#fff',
    display: 'grid', placeItems: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(26,115,232,.24)' }}>✦</div>;
}

function ProcessEvent({ event }: { event: AgentEvent }) {
  const theme = useAgentTheme();
  if (event.type === 'progress') return <div style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 1.7, margin: '6px 0' }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
  </div>;
  if (event.type === 'tool_started' || event.type === 'tool_finished') {
    const finished = event.type === 'tool_finished';
    return <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', color: theme.textSecondary, fontSize: 12 }}>
      {finished ? <CheckCircleOutlined style={{ color: '#10b981' }} /> : <CodeOutlined style={{ color: '#1a73e8' }} />}
      <span>{finished ? '工具执行完成' : '正在使用工具'}</span>
      {event.toolName && <code style={{ padding: '2px 7px', borderRadius: 5, background: theme.codeBg }}>{event.toolName}</code>}
      {event.durationMs != null && <span style={{ opacity: .65 }}>{event.durationMs}ms</span>}
    </div>;
  }
  return null;
}

function ErrorBlock({ event }: { event: AgentEvent }) {
  const theme = useAgentTheme();
  const code = event.terminal?.errorCode;
  return <div role="alert" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8,
    border: `1px solid ${theme.errorBorder}`, background: theme.errorBg, color: theme.errorText, whiteSpace: 'pre-wrap' }}>
    <WarningOutlined style={{ marginRight: 8 }} />{event.content || '执行失败'}{code ? `（${code}）` : ''}
  </div>;
}

interface Turn { type: 'user' | 'assistant'; events: AgentEvent[]; }
function groupTurns(events: AgentEvent[]): Turn[] {
  const turns: Turn[] = [];
  let assistant: AgentEvent[] = [];
  for (const event of events) {
    if (event.type === 'user') {
      if (assistant.length) turns.push({ type: 'assistant', events: assistant });
      assistant = [];
      turns.push({ type: 'user', events: [event] });
    } else assistant.push(event);
  }
  if (assistant.length) turns.push({ type: 'assistant', events: assistant });
  return turns;
}

export function AgentEventList({ events, userPrompt, reportUrl, reportMeta, runId, isStreaming = false,
  onConfirm, confirmationDisabled = false, onApproval, approvalDisabled = false }: {
  events: AgentEvent[]; userPrompt: string; reportUrl?: string | null;
  reportMeta?: { title: string; summary: string } | null; runId?: string | null; isStreaming?: boolean;
  autoCollapseIntermediates?: boolean;
  onConfirm?: (response: string) => void; confirmationDisabled?: boolean;
  onApproval?: (approvalId: string, decision: 'approved' | 'denied') => void; approvalDisabled?: boolean;
}) {
  const theme = useAgentTheme();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);
  const turns = groupTurns(events);
  const latestTurn = turns[turns.length - 1];
  const waitingForFirstStep = isStreaming && latestTurn?.type === 'user';
  const empty = !userPrompt && !events.length && !reportUrl;
  return <div style={{ height: '100%' }}>
    {empty && <div style={{ textAlign: 'center', padding: '88px 20px', color: theme.textSecondary }}>
      <div style={{ fontSize: 28, color: '#1a73e8', marginBottom: 14 }}>✦</div>
      <div style={{ color: theme.text, fontSize: 17, fontWeight: 600 }}>开始新的策略研究对话</div>
      <div style={{ marginTop: 7, fontSize: 13 }}>输入问题或研究需求，过程会简洁收起，结论保持清晰。</div>
    </div>}
    {userPrompt && <UserBubble text={userPrompt} />}
    {turns.map((turn, index) => {
      if (turn.type === 'user') return <UserBubble key={`u-${index}`} text={turn.events[0].content} />;
      const current = isStreaming && index === turns.length - 1;
      const process = turn.events.filter(event => ['progress', 'tool_started', 'tool_finished'].includes(event.type));
      const final = turn.events.filter(event => event.type === 'assistant_final' || event.type === 'assistant_text');
      const finalContents = new Set(final.map(event => event.content.trim()).filter(Boolean));
      const visibleProcess = process.slice(-200).map(event => (
        event.type === 'progress' && finalContents.has(event.content.trim())
          ? { ...event, content: '正在整理最终回答' }
          : event
      ));
      // Individual tool failures are implementation detail: the agent may recover by
      // retrying or choosing another tool. Keep only run-level errors user-visible.
      const errors = turn.events.filter(event =>
        (event.type === 'error' && !event.toolUseId)
        || (event.type === 'terminal' && event.terminal?.status !== 'completed'));
      const confirmations = turn.events.filter(event => event.type === 'confirmation_required' && !event.approval);
      const approvals = [...turn.events.reduce((map, event) => {
        if (event.type === 'confirmation_required' && event.approval) map.set(event.approval.id, event);
        return map;
      }, new Map<string, AgentEvent>()).values()];
      const confirmationAnswered = turns.slice(index + 1).some(later => later.type === 'user');
      const completedWithoutFinal = turn.events.some(event => event.type === 'terminal' && event.terminal?.status === 'completed') && final.length === 0;
      if (!process.length && !final.length && !errors.length && !confirmations.length && !approvals.length) return null;
      const first = turn.events.find(event => event.timestamp)?.timestamp;
      const last = [...turn.events].reverse().find(event => event.timestamp)?.timestamp;
      const duration = calcDuration(first, current ? new Date(clock).toISOString() : last);
      const turnRunId = turn.events.find(event => event.runId)?.runId ?? runId ?? 'history';
      const key = `${turnRunId}:${index}:${first ?? 'none'}`;
      return <div key={key} style={{ display: 'flex', gap: 12, margin: '8px 0 26px' }}>
        <AssistantAvatar />
        <div style={{ flex: 1, minWidth: 0 }}>
          {process.length > 0 && <Fold instanceKey={key} openWhileRunning={current}
            label={`已处理${duration ? ` ${duration}` : ''} · ${process.length}步`}>
            {process.length > visibleProcess.length && <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>
              较早的 {process.length - visibleProcess.length} 个步骤已省略，可按事件分页接口查询。
            </div>}
            {visibleProcess.map((event, eventIndex) => <ProcessEvent key={`${event.seq ?? eventIndex}`} event={event} />)}
            {current && <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8,
              marginTop: 8, paddingTop: 9, borderTop: `1px dashed ${theme.borderSubtle}`,
              color: theme.textSecondary, fontSize: 12 }}>
              <LoadingOutlined style={{ color: '#1a73e8' }} />
              <span>分析仍在继续{duration ? ` · 已处理 ${duration}` : ''}</span>
            </div>}
          </Fold>}
          {final.map((event, eventIndex) => <div className="markdown-preview" key={`${event.seq ?? eventIndex}`}
            style={{ color: theme.text, fontSize: 15, lineHeight: 1.78 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
          </div>)}
          {errors.map((event, eventIndex) => <ErrorBlock key={`${event.seq ?? eventIndex}`} event={event} />)}
          {confirmations.map((event, eventIndex) => <AgentConfirmationCard key={`${event.seq ?? eventIndex}`}
            content={event.content} onSubmit={onConfirm} disabled={confirmationDisabled}
            answered={confirmationAnswered} />)}
          {approvals.map(event => <ApprovalCard key={event.approval!.id} event={event}
            disabled={approvalDisabled} onDecision={onApproval} />)}
          {completedWithoutFinal && <div role="status" style={{ color: theme.textSecondary, fontSize: 13 }}>本轮已结束，但未生成最终回答。</div>}
        </div>
      </div>;
    })}
    {waitingForFirstStep && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 12, margin: '8px 0 26px' }}>
      <AssistantAvatar />
      <div style={{ color: theme.textSecondary, fontSize: 13, minHeight: 42, display: 'flex', alignItems: 'center', gap: 9 }}>
        <LoadingOutlined style={{ color: '#1a73e8' }} />
        <span>正在分析任务{latestTurn?.events[0]?.timestamp
          ? ` · 已处理 ${calcDuration(latestTurn.events[0].timestamp, new Date(clock).toISOString())}` : ''}</span>
      </div>
    </div>}
    {reportUrl && reportMeta && runId && <div style={{ margin: '18px 0', border: `1px solid ${theme.border}`,
      borderRadius: 14, overflow: 'hidden' }}>
      <AgentReportView reportUrl={reportUrl} reportMeta={reportMeta} runId={runId} embedded />
    </div>}
  </div>;
}

function ApprovalCard({ event, disabled, onDecision }: {
  event: AgentEvent; disabled: boolean;
  onDecision?: (approvalId: string, decision: 'approved' | 'denied') => void;
}) {
  const theme = useAgentTheme();
  const approval = event.approval!;
  const pending = approval.status === 'pending';
  const labels = { command: '命令执行', file_change: '文件修改', network: '网络访问', permissions: '权限升级' };
  return <section aria-label="Codex 操作审批" style={{ marginTop: 16, padding: '18px 20px', borderRadius: 13,
    border: `1px solid ${theme.border}`, background: theme.bgCard }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: theme.text, fontWeight: 600 }}>
      {pending ? <SafetyCertificateOutlined style={{ color: '#f59e0b' }} />
        : approval.status === 'approved' ? <CheckCircleOutlined style={{ color: '#10b981' }} />
          : <CloseCircleOutlined style={{ color: '#ef4444' }} />}
      <span>{pending ? `等待批准：${labels[approval.requestType]}` : `审批结果：${approval.status}`}</span>
    </div>
    <p style={{ color: theme.textSecondary, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{approval.summary}</p>
    <small style={{ color: theme.textSecondary }}>到期时间：{new Date(approval.expiresAt).toLocaleString('zh-CN', { hour12: false })}</small>
    {pending && <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
      <Button danger disabled={disabled} onClick={() => onDecision?.(approval.id, 'denied')}>拒绝</Button>
      <Button type="primary" disabled={disabled} onClick={() => onDecision?.(approval.id, 'approved')}>批准一次</Button>
    </div>}
  </section>;
}

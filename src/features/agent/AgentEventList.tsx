import { useRef, useEffect, useId, useState } from 'react';
import { Tag } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  UserOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentTheme } from '@/theme';
import type { AgentEvent } from './types';
import { AgentReportView } from './AgentReportView';

export function calcDuration(prevTimestamp?: string, currTimestamp?: string): string {
  if (!prevTimestamp || !currTimestamp) return '';
  try {
    const diff = new Date(currTimestamp).getTime() - new Date(prevTimestamp).getTime();
    if (diff < 0) return '';
    if (diff < 1000) return `${diff}ms`;
    if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`;
    return `${Math.floor(diff / 60000)}m${Math.floor((diff % 60000) / 1000)}s`;
  } catch {
    return '';
  }
}

function formatDuration(fromTs?: string, toTs?: string): string {
  if (!fromTs || !toTs) return '';
  try {
    const diff = new Date(toTs).getTime() - new Date(fromTs).getTime();
    if (diff < 0) return '';
    if (diff < 1000) return `${diff}毫秒`;
    if (diff < 60000) return `${Math.floor(diff / 1000)}秒`;
    return `${Math.floor(diff / 60000)}分 ${Math.floor((diff % 60000) / 1000)}秒`;
  } catch {
    return '';
  }
}

// ChatGPT同款：折叠思考/工具块（极细线框）。支持：
// 1) defaultOpen 仅在首次挂载时生效（用户手动切换优先级最高）
// 2) forcedOpen 为强制受控值（非 undefined 时覆盖用户手动状态）
function Accordion({
  label,
  children,
  defaultOpen = false,
  forcedOpen,
  instanceKey,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  forcedOpen?: boolean;
  instanceKey?: string;
}) {
  const t = useAgentTheme();
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const contentId = useId();
  const userTouchedRef = useRef(false);
  const lastKeyRef = useRef<string | undefined>(undefined);
  if (instanceKey !== lastKeyRef.current) {
    lastKeyRef.current = instanceKey;
    userTouchedRef.current = false;
  }

  useEffect(() => {
    if (forcedOpen !== undefined && !userTouchedRef.current) {
      setOpen(forcedOpen);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedOpen, instanceKey]);

  return (
    <div
      style={{
        margin: '2px 0 14px',
        borderBottom: `1px solid ${t.borderSubtle}`,
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          userTouchedRef.current = true;
          setOpen(o => !o);
        }}
        style={{
          width: '100%',
          padding: '4px 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textAlign: 'left',
          fontSize: 13,
          color: t.textSecondary,
          lineHeight: 1.3,
          minHeight: 44,
          outlineOffset: -2,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ opacity: 0.55, flexShrink: 0, display: 'flex' }}>
          {open ? <DownOutlined style={{ fontSize: 9 }} /> : <RightOutlined style={{ fontSize: 9 }} />}
        </span>
      </button>
      {open && (
        <div id={contentId} style={{ padding: '4px 0 12px', fontSize: 12 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function CodeBlock({ text, color }: { text: string; color: string }) {
  const t = useAgentTheme();
  return (
    <pre
      style={{
        margin: '4px 0 0',
        padding: '8px 10px',
        background: t.codeBg,
        borderRadius: 6,
        fontSize: 12,
        overflowX: 'auto',
        maxHeight: 280,
        color,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        border: `1px solid ${t.codeBorder}`,
      }}
    >
      {text}
    </pre>
  );
}

function UserBubble({ text }: { text: string }) {
  const t = useAgentTheme();
  return (
    <div style={{ display: 'flex', gap: 10, margin: '20px 0 24px', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '72%',
          background: t.bgUserBubble,
          color: t.text,
          padding: '10px 16px',
          borderRadius: '20px 20px 4px 20px',
          fontSize: 15,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
        }}
      >
        {text}
      </div>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: t.bgHover,
          color: t.textSecondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          alignSelf: 'flex-end',
          marginBottom: 2,
          fontSize: 13,
        }}
      >
        <UserOutlined />
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        background: '#1a73e8',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginTop: 4,
        fontSize: 14,
        boxShadow: '0 1px 3px rgba(26,115,232,0.3)',
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L15 8l7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
      </svg>
    </div>
  );
}

// 单个中间事件的渲染（折叠在 IntermediateGroup 内部）
function IntermediateEventItem({ ev }: { ev: AgentEvent }) {
  const t = useAgentTheme();
  if (ev.type === 'text' && ev.content.trim()) {
    return (
      <div
        className="markdown-preview"
        style={{
          margin: '10px 0',
          color: t.textSecondary,
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{ev.content}</ReactMarkdown>
      </div>
    );
  }

  if (ev.type === 'thought') {
    return (
      <div style={{ margin: '3px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>
          <BulbOutlined style={{ fontSize: 10 }} />
          <span>思考</span>
        </div>
        <div
          style={{
            margin: 0,
            color: '#6b7280',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.55,
            paddingLeft: 16,
          }}
        >
          {ev.content}
        </div>
      </div>
    );
  }

  if (ev.type === 'tool_use') {
    return (
      <div style={{ margin: '3px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#1a73e8', marginBottom: 2 }}>
          <CodeOutlined style={{ fontSize: 10 }} />
          <span>使用工具</span>
          {ev.toolName && (
            <Tag color="blue" style={{ margin: 0, fontSize: 10, borderRadius: 4, padding: '0 6px', lineHeight: '18px' }}>
              {ev.toolName}
            </Tag>
          )}
        </div>
        {ev.toolInput && (
          <div style={{ paddingLeft: 16 }}>
            <CodeBlock text={ev.toolInput} color="#4b5563" />
          </div>
        )}
      </div>
    );
  }

  if (ev.type === 'tool_result') {
    return (
      <div style={{ margin: '3px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#10b981', marginBottom: 2 }}>
          <CheckCircleOutlined style={{ fontSize: 10 }} />
          <span>执行结果</span>
          {ev.toolName && (
            <Tag color="green" style={{ margin: 0, fontSize: 10, borderRadius: 4, padding: '0 6px', lineHeight: '18px' }}>
              {ev.toolName}
            </Tag>
          )}
        </div>
        {ev.toolResult && (
          <div style={{ paddingLeft: 16 }}>
            <CodeBlock text={ev.toolResult} color="#065f46" />
          </div>
        )}
      </div>
    );
  }

  if (ev.type === 'error') {
    return (
      <div
        style={{
          background: t.errorBg,
          border: `1px solid ${t.errorBorder}`,
          padding: '6px 10px',
          borderRadius: 6,
          fontSize: 12,
          color: t.errorText,
          margin: '3px 0',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.5,
        }}
      >
        <WarningOutlined style={{ marginRight: 6 }} />
        {ev.content}
      </div>
    );
  }

  return null;
}

// 每个助手回合只有一个处理摘要：阶段文本、思考与工具事件全部收在这里。
function ProcessGroup({
  events,
  isStreaming,
  groupKey,
  durationEndTimestamp,
}: {
  events: AgentEvent[];
  isStreaming: boolean;
  groupKey: string;
  durationEndTimestamp?: string;
}) {
  const firstTs = events[0]?.timestamp;
  const lastTs = durationEndTimestamp ?? events[events.length - 1]?.timestamp;
  const duration = formatDuration(firstTs, lastTs);
  const labelText = duration ? `已处理 ${duration}` : `已处理 ${events.length} 步`;

  return (
    <Accordion
      instanceKey={groupKey}
      forcedOpen={isStreaming}
      defaultOpen={false}
      label={<span style={{ fontWeight: 400 }}>{labelText}</span>}
    >
      <div style={{ maxHeight: 520, overflowY: 'auto', paddingRight: 6 }}>
        {events.map((ev, idx) => (
          <IntermediateEventItem key={idx} ev={ev} />
        ))}
      </div>
    </Accordion>
  );
}

// 结论块：文本输出（展开显示）
function ConclusionBlock({ events }: { events: AgentEvent[] }) {
  const t = useAgentTheme();
  return (
    <div
      style={{
        margin: '8px 0 0',
        padding: 0,
      }}
    >
      {events.map((ev, idx) => (
        <div
          key={idx}
          className="markdown-preview"
          style={{
            fontSize: 15,
            lineHeight: 1.75,
            color: t.text,
            marginTop: idx === 0 ? 0 : 8,
            marginBottom: 0,
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {ev.content}
          </ReactMarkdown>
        </div>
      ))}
    </div>
  );
}

// 将事件分组为对话轮次：用户消息 / 助手事件序列
interface Turn {
  type: 'user' | 'assistant';
  events: AgentEvent[];
}

function groupTurns(events: AgentEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: AgentEvent[] = [];

  for (const ev of events) {
    if (ev.type === 'user') {
      if (current.length > 0) {
        turns.push({ type: 'assistant', events: current });
        current = [];
      }
      turns.push({ type: 'user', events: [ev] });
    } else {
      current.push(ev);
    }
  }
  if (current.length > 0) {
    turns.push({ type: 'assistant', events: current });
  }

  return turns;
}

interface Props {
  events: AgentEvent[];
  userPrompt: string;
  reportUrl?: string | null;
  reportMeta?: { title: string; summary: string } | null;
  runId?: string | null;
  isStreaming?: boolean;
  autoCollapseIntermediates?: boolean;
}

export function AgentEventList({
  events,
  userPrompt,
  reportUrl,
  reportMeta,
  runId,
  isStreaming = false,
}: Props) {
  const t = useAgentTheme();
  const displayEvents = events.filter(e => e.type !== 'done');
  const turns = groupTurns(displayEvents);
  const hasContent = userPrompt || displayEvents.length > 0 || (reportUrl && reportMeta);

  return (
    <div style={{ height: '100%', overflow: 'visible' }}>
      {!hasContent && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: t.textSecondary }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: t.bgSelected,
              color: t.textOnBlue,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 20px',
              fontSize: 26,
            }}
          >
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: t.text, marginBottom: 6 }}>
            开始新的策略研究对话
          </div>
          <div style={{ fontSize: 13, color: t.textMuted }}>
            输入你的问题或策略描述，万行智研会逐步执行并生成报告
          </div>
        </div>
      )}

      {userPrompt && <UserBubble text={userPrompt} />}

      {turns.map((turn, turnIdx) => {
        if (turn.type === 'user') {
          return <UserBubble key={`turn-${turnIdx}`} text={turn.events[0].content} />;
        }

        const isCurrentTurn = turnIdx === turns.length - 1;
        const turnIsStreaming = isStreaming && isCurrentTurn;
        const meaningfulEvents = turn.events.filter(event => (
          event.type !== 'done' && (event.type !== 'text' || event.content.trim().length > 0)
        ));
        if (meaningfulEvents.length === 0) return null;

        // 运行完成后，仅最后一条正式文本留在正文；此前所有阶段性文本、
        // 思考和工具事件统一进入一个“已处理 …”摘要。
        const lastEventIndex = meaningfulEvents.length - 1;
        const finalTextIndex = !turnIsStreaming && meaningfulEvents[lastEventIndex]?.type === 'text'
          ? lastEventIndex
          : -1;
        const finalEvents = finalTextIndex >= 0 ? [meaningfulEvents[finalTextIndex]] : [];
        const processEvents = meaningfulEvents.filter((_, index) => index !== finalTextIndex);
        const durationEndTimestamp = meaningfulEvents[meaningfulEvents.length - 1]?.timestamp;

        return (
          <div key={`turn-${turnIdx}`} style={{ margin: '8px 0 24px', display: 'flex', gap: 12 }}>
            <AssistantAvatar />
            <div style={{ flex: 1, minWidth: 0 }}>
              {processEvents.length > 0 && (
                <ProcessGroup
                  events={processEvents}
                  isStreaming={turnIsStreaming}
                  groupKey={`turn-${turnIdx}-process`}
                  durationEndTimestamp={durationEndTimestamp}
                />
              )}
              {finalEvents.length > 0 && <ConclusionBlock events={finalEvents} />}
            </div>
          </div>
        );
      })}

      {reportUrl && reportMeta && runId && (
        <div style={{ margin: '20px 0 8px', display: 'flex', gap: 12 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: '#1a73e8',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: 4,
              fontSize: 14,
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="16" y2="17" />
            </svg>
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              background: t.bgCard,
              border: `1px solid ${t.border}`,
              borderRadius: 14,
              overflow: 'hidden',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)',
            }}
          >
            <AgentReportView
              reportUrl={reportUrl}
              reportMeta={reportMeta}
              runId={runId}
              embedded
            />
          </div>
        </div>
      )}
    </div>
  );
}

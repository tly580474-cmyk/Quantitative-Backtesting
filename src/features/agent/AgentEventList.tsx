import { useRef, useEffect, useState } from 'react';
import { Tag } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  UserOutlined,
  DownOutlined,
  UpOutlined,
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
    if (diff < 1000) return `${diff}ms`;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
    return `${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`;
  } catch {
    return '';
  }
}

// ChatGPT同款：折叠思考/工具块（极细线框）。支持：
// 1) defaultOpen 仅在首次挂载时生效（用户手动切换优先级最高）
// 2) forcedOpen 为强制受控值（非 undefined 时覆盖用户手动状态）
function Accordion({
  label,
  icon,
  color,
  children,
  defaultOpen = false,
  forcedOpen,
  instanceKey,
}: {
  label: React.ReactNode;
  icon: React.ReactNode;
  color: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  forcedOpen?: boolean;
  instanceKey?: string;
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen);
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
        margin: '6px 0',
        border: `1px solid ${color}22`,
        background: `${color}08`,
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => {
          userTouchedRef.current = true;
          setOpen(o => !o);
        }}
        style={{
          width: '100%',
          padding: '6px 11px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          textAlign: 'left',
          fontSize: 12,
          color: '#8e8ea0',
          lineHeight: 1.3,
        }}
      >
        <span style={{ color, display: 'flex', alignItems: 'center' }}>{icon}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ opacity: 0.5, flexShrink: 0 }}>
          {open ? <UpOutlined style={{ fontSize: 9 }} /> : <DownOutlined style={{ fontSize: 9 }} />}
        </span>
      </button>
      {open && (
        <div style={{ padding: '4px 11px 10px', fontSize: 12, borderTop: `1px solid ${color}14` }}>
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
          {ev.content.length > 200 ? ev.content.slice(0, 200) + '…' : ev.content}
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

// 中间步骤分组：将连续的 thought/tool_use/tool_result 合并为一个可折叠块
function IntermediateGroup({
  events,
  isStreaming,
  isLastIntermediateGroup,
  autoCollapseIntermediates,
  groupKey,
}: {
  events: AgentEvent[];
  isStreaming: boolean;
  isLastIntermediateGroup: boolean;
  autoCollapseIntermediates: boolean;
  groupKey: string;
}) {
  const firstTs = events[0]?.timestamp;
  const lastTs = events[events.length - 1]?.timestamp;
  const duration = formatDuration(firstTs, lastTs);
  const stepCount = events.length;

  // 完成后所有中间步骤自动折叠；流式中最后一个中间组保持展开
  let forcedOpen: boolean | undefined;
  if (autoCollapseIntermediates) {
    forcedOpen = false;
  } else if (isStreaming && isLastIntermediateGroup) {
    forcedOpen = true;
  }

  const labelText = duration
    ? `已处理 ${duration} · ${stepCount} 步`
    : `已处理 ${stepCount} 步`;

  return (
    <Accordion
      instanceKey={groupKey}
      forcedOpen={forcedOpen}
      defaultOpen={false}
      label={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#6b7280', fontWeight: 500 }}>{labelText}</span>
        </span>
      }
      icon={<BulbOutlined style={{ fontSize: 12 }} />}
      color="#6b7280"
    >
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
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
        margin: '8px 0',
        padding: '14px 16px',
        background: t.bgCard,
        border: `1px solid ${t.border}`,
        borderRadius: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
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

// 高5: 中间结论块 — 运行结束后折叠非最终的文本输出
function CollapsibleConclusionBlock({ events, label }: { events: AgentEvent[]; label: string }) {
  const t = useAgentTheme();
  return (
    <Accordion
      label={<span style={{ color: t.textSecondary, fontWeight: 500 }}>{label}</span>}
      icon={<CodeOutlined style={{ fontSize: 12 }} />}
      color={t.textMuted}
      defaultOpen={false}
    >
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {events.map((ev, idx) => (
          <div
            key={idx}
            className="markdown-preview"
            style={{
              fontSize: 13,
              lineHeight: 1.7,
              color: t.textSecondary,
              marginTop: idx === 0 ? 0 : 8,
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {ev.content}
            </ReactMarkdown>
          </div>
        ))}
      </div>
    </Accordion>
  );
}

// 将助手事件拆分为交替的中间组和文本组
type Segment =
  | { kind: 'intermediate'; events: AgentEvent[] }
  | { kind: 'text'; events: AgentEvent[] };

function splitIntoSegments(events: AgentEvent[]): Segment[] {
  const segments: Segment[] = [];
  let currentIntermediate: AgentEvent[] = [];
  let currentText: AgentEvent[] = [];

  const flushIntermediate = () => {
    if (currentIntermediate.length > 0) {
      segments.push({ kind: 'intermediate', events: currentIntermediate });
      currentIntermediate = [];
    }
  };
  const flushText = () => {
    if (currentText.length > 0) {
      segments.push({ kind: 'text', events: currentText });
      currentText = [];
    }
  };

  for (const ev of events) {
    if (ev.type === 'thought' || ev.type === 'tool_use' || ev.type === 'tool_result' || ev.type === 'error') {
      flushText();
      currentIntermediate.push(ev);
    } else if (ev.type === 'text') {
      if (!ev.content.trim()) continue;
      flushIntermediate();
      currentText.push(ev);
    }
  }
  flushIntermediate();
  flushText();

  return segments;
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
  autoCollapseIntermediates = false,
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
            输入你的问题或策略描述，智能体会逐步执行并生成报告
          </div>
        </div>
      )}

      {userPrompt && <UserBubble text={userPrompt} />}

      {turns.map((turn, turnIdx) => {
        if (turn.type === 'user') {
          return <UserBubble key={`turn-${turnIdx}`} text={turn.events[0].content} />;
        }

        const segments = splitIntoSegments(turn.events);
        if (segments.length === 0) return null;

        // 计算中间段的索引（用于判断哪个是最后一个）
        const intermediateIndices: number[] = [];
        const textIndices: number[] = [];
        segments.forEach((seg, i) => {
          if (seg.kind === 'intermediate') intermediateIndices.push(i);
          else textIndices.push(i);
        });
        const lastIntermediateIdx = intermediateIndices.length > 0
          ? intermediateIndices[intermediateIndices.length - 1]
          : -1;
        const lastTextIdx = textIndices.length > 0
          ? textIndices[textIndices.length - 1]
          : -1;

        return (
          <div key={`turn-${turnIdx}`} style={{ margin: '8px 0 24px', display: 'flex', gap: 12 }}>
            <AssistantAvatar />
            <div style={{ flex: 1, minWidth: 0 }}>
              {segments.map((seg, segIdx) => {
                if (seg.kind === 'intermediate') {
                  return (
                    <IntermediateGroup
                      key={`seg-${segIdx}`}
                      events={seg.events}
                      isStreaming={isStreaming}
                      isLastIntermediateGroup={segIdx === lastIntermediateIdx}
                      autoCollapseIntermediates={autoCollapseIntermediates}
                      groupKey={`turn-${turnIdx}-seg-${segIdx}`}
                    />
                  );
                }
                // 高5: 运行结束后，非最终的文本块折叠为可展开的中间结论
                if (autoCollapseIntermediates && segIdx !== lastTextIdx) {
                  return (
                    <CollapsibleConclusionBlock
                      key={`seg-${segIdx}`}
                      events={seg.events}
                      label="中间结论"
                    />
                  );
                }
                return <ConclusionBlock key={`seg-${segIdx}`} events={seg.events} />;
              })}
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

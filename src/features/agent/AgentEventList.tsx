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
  // 用户手动点击后，在同一 instanceKey 周期内忽略后续的 forcedOpen
  const userTouchedRef = useRef(false);
  // 当 instanceKey 变化时，重置用户手动标记（一个全新的 Accordion 实例）
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
  return (
    <pre
      style={{
        margin: '4px 0 0',
        padding: '8px 10px',
        background: '#ffffff',
        borderRadius: 6,
        fontSize: 12,
        overflowX: 'auto',
        maxHeight: 280,
        color,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        border: '1px solid #f0f0f0',
      }}
    >
      {text}
    </pre>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, margin: '20px 0 24px', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '72%',
          background: '#f9fafb',
          color: '#1f2937',
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
          background: '#e5e7eb',
          color: '#6b7280',
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

function AssistantEventBlock({
  ev,
  eventIndex,
  totalVisible,
  isStreaming,
  autoCollapseIntermediates,
}: {
  ev: AgentEvent;
  eventIndex: number;
  totalVisible: number;
  isStreaming: boolean;
  autoCollapseIntermediates: boolean;
}) {
  // 流式阶段：最后一个块（最新的）保持展开；其它用户没动过的保持折叠即可
  // 完成阶段（autoCollapseIntermediates）：所有中间类型强制折叠
  const isLast = eventIndex === totalVisible - 1;
  const intermediateEv = ev.type === 'thought' || ev.type === 'tool_use' || ev.type === 'tool_result';
  let forcedOpen: boolean | undefined;
  if (autoCollapseIntermediates && intermediateEv) {
    // 完成后：中间步骤全部折叠
    forcedOpen = false;
  } else if (isStreaming) {
    // 流式中：最后一项始终展开（让用户看到最新内容）；其它保持用户手动状态（undefined 不强制）
    if (intermediateEv && isLast) forcedOpen = true;
  }
  const instanceKey = `${ev.type}-${eventIndex}-${ev.timestamp ?? ''}`;

  // 思考内容
  if (ev.type === 'thought') {
    return (
      <Accordion
        instanceKey={instanceKey}
        forcedOpen={forcedOpen}
        label={
          <span style={{ color: '#8e8ea0' }}>
            思考
            <span style={{ opacity: 0.7, marginLeft: 6, fontSize: 11 }}>
              · {ev.content.length > 60 ? ev.content.slice(0, 60) + '…' : ev.content}
            </span>
          </span>
        }
        icon={<BulbOutlined style={{ fontSize: 12 }} />}
        color="#9ca3af"
      >
        <div
          style={{
            margin: 0,
            color: '#6b7280',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.6,
          }}
        >
          {ev.content}
        </div>
      </Accordion>
    );
  }

  // 工具调用
  if (ev.type === 'tool_use') {
    return (
      <Accordion
        instanceKey={instanceKey}
        forcedOpen={forcedOpen}
        label={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#8e8ea0' }}>使用工具</span>
            {ev.toolName && (
              <Tag
                color="blue"
                style={{ margin: 0, fontSize: 10, borderRadius: 4, padding: '0 6px', lineHeight: '18px' }}
              >
                {ev.toolName}
              </Tag>
            )}
          </span>
        }
        icon={<CodeOutlined style={{ fontSize: 12 }} />}
        color="#1a73e8"
      >
        {ev.toolInput && (
          <div style={{ margin: '4px 0' }}>
            <CodeBlock text={ev.toolInput} color="#4b5563" />
          </div>
        )}
      </Accordion>
    );
  }

  // 工具执行结果
  if (ev.type === 'tool_result') {
    return (
      <Accordion
        instanceKey={instanceKey}
        forcedOpen={forcedOpen}
        label={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#8e8ea0' }}>执行结果</span>
            {ev.toolName && (
              <Tag
                color="green"
                style={{ margin: 0, fontSize: 10, borderRadius: 4, padding: '0 6px', lineHeight: '18px' }}
              >
                {ev.toolName}
              </Tag>
            )}
          </span>
        }
        icon={<CheckCircleOutlined style={{ fontSize: 12 }} />}
        color="#10b981"
      >
        {ev.toolResult && (
          <CodeBlock text={ev.toolResult} color="#065f46" />
        )}
      </Accordion>
    );
  }

  // 文本输出：渲染为 Markdown
  if (ev.type === 'text') {
    if (!ev.content.trim()) return null;
    return (
      <div
        className="markdown-preview"
        style={{
          fontSize: 15,
          lineHeight: 1.75,
          color: '#374151',
          marginTop: 4,
          marginBottom: 4,
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {ev.content}
        </ReactMarkdown>
      </div>
    );
  }

  // 错误：红底卡片
  if (ev.type === 'error') {
    return (
      <div
        style={{
          background: '#fef2f2',
          border: '1px solid #fee2e2',
          padding: '10px 12px',
          borderRadius: 10,
          fontSize: 13,
          color: '#b91c1c',
          margin: '6px 0',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
        }}
      >
        <WarningOutlined style={{ marginRight: 6 }} />
        {ev.content}
      </div>
    );
  }

  return null;
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
  // Filter out 'done' events — they're handled by status display
  const displayEvents = events.filter(e => e.type !== 'done');
  const turns = groupTurns(displayEvents);
  const hasContent = userPrompt || displayEvents.length > 0 || (reportUrl && reportMeta);

  return (
    <div style={{ height: '100%', overflow: 'visible' }}>
      {!hasContent && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: '#8e8ea0' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #e8f0fe, #f0f7ff)',
              color: '#1a73e8',
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
          <div style={{ fontSize: 17, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
            开始新的策略研究对话
          </div>
          <div style={{ fontSize: 13, color: '#9ca3af' }}>
            输入你的问题或策略描述，智能体会逐步执行并生成报告
          </div>
        </div>
      )}

      {/* 初始用户消息 */}
      {userPrompt && <UserBubble text={userPrompt} />}

      {/* 按轮次交替渲染用户消息和助手回复 */}
      {turns.map((turn, turnIdx) => {
        if (turn.type === 'user') {
          return <UserBubble key={`turn-${turnIdx}`} text={turn.events[0].content} />;
        }

        // 助手事件序列
        const visibleEvents = turn.events.filter(ev => !(ev.type === 'text' && !ev.content.trim()));
        if (visibleEvents.length === 0) return null;
        const totalVisible = visibleEvents.length;

        return (
          <div key={`turn-${turnIdx}`} style={{ margin: '8px 0 24px', display: 'flex', gap: 12 }}>
            <AssistantAvatar />
            <div style={{ flex: 1, minWidth: 0 }}>
              {visibleEvents.map((ev, evIdx) => (
                <AssistantEventBlock
                  key={evIdx}
                  ev={ev}
                  eventIndex={evIdx}
                  totalVisible={totalVisible}
                  isStreaming={isStreaming}
                  autoCollapseIntermediates={autoCollapseIntermediates}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* 报告卡片 */}
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
              background: '#fff',
              border: '1px solid #e5e7eb',
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

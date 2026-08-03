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

// ChatGPT同款：折叠思考/工具块（极细线框），默认折叠
function Accordion({
  label,
  icon,
  color,
  children,
  defaultOpen = false,
}: {
  label: React.ReactNode;
  icon: React.ReactNode;
  color: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        onClick={() => setOpen(o => !o)}
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

function AssistantEventBlock({ ev }: { ev: AgentEvent }) {
  // 思考内容：默认折叠
  if (ev.type === 'thought') {
    return (
      <Accordion
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

  // 工具调用：默认折叠
  if (ev.type === 'tool_use') {
    return (
      <Accordion
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

  // 工具执行结果：默认折叠
  if (ev.type === 'tool_result') {
    return (
      <Accordion
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
}

export function AgentEventList({ events, userPrompt, reportUrl, reportMeta, runId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter out 'done' events — they're handled by status display
  const displayEvents = events.filter(e => e.type !== 'done');
  const turns = groupTurns(displayEvents);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayEvents.length]);

  const hasContent = userPrompt || displayEvents.length > 0 || (reportUrl && reportMeta);

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'visible' }}>
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
      {turns.map((turn, idx) => {
        if (turn.type === 'user') {
          return <UserBubble key={`turn-${idx}`} text={turn.events[0].content} />;
        }

        // 助手事件序列
        const visibleEvents = turn.events.filter(ev => !(ev.type === 'text' && !ev.content.trim()));
        if (visibleEvents.length === 0) return null;

        return (
          <div key={`turn-${idx}`} style={{ margin: '8px 0 24px', display: 'flex', gap: 12 }}>
            <AssistantAvatar />
            <div style={{ flex: 1, minWidth: 0 }}>
              {visibleEvents.map((ev, evIdx) => (
                <AssistantEventBlock key={evIdx} ev={ev} />
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

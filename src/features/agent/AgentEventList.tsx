import { useRef, useEffect, useState } from 'react';
import { Typography, Tooltip, Tag } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  UserOutlined,
  DownOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { AgentEvent } from './types';
import { AgentReportView } from './AgentReportView';

const { Text, Paragraph } = Typography;

function formatTime(timestamp?: string): string {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

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

interface AssistantTurn {
  kind: 'assistant';
  events: AgentEvent[];
  startTime?: string;
  endTime?: string;
}

interface UserMessage {
  kind: 'user';
  content: string;
  timestamp?: string;
}

interface ReportMessage {
  kind: 'report';
  reportUrl: string;
  reportMeta: { title: string; summary: string };
  runId: string;
}

type ConversationItem = UserMessage | AssistantTurn | ReportMessage;

function groupEvents(
  events: AgentEvent[],
  userPrompt: string,
  report: { url: string | null; meta: { title: string; summary: string } | null; runId: string | null },
): ConversationItem[] {
  const items: ConversationItem[] = [];
  if (userPrompt) {
    items.push({ kind: 'user', content: userPrompt });
  }
  let currentTurn: AssistantTurn | null = null;
  for (const ev of events) {
    if (ev.type === 'done') continue;
    if (!currentTurn) {
      currentTurn = { kind: 'assistant', events: [ev], startTime: ev.timestamp, endTime: ev.timestamp };
    } else {
      currentTurn.events.push(ev);
      if (ev.timestamp) currentTurn.endTime = ev.timestamp;
    }
  }
  if (currentTurn) items.push(currentTurn);
  if (report.url && report.meta && report.runId) {
    items.push({
      kind: 'report',
      reportUrl: report.url,
      reportMeta: report.meta,
      runId: report.runId,
    });
  }
  return items;
}

// ChatGPT同款：折叠思考/工具块（极细线框）
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
        margin: '10px 0 6px',
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
          padding: '7px 11px',
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
        margin: '6px 0 0',
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

interface Props {
  events: AgentEvent[];
  userPrompt: string;
  reportUrl?: string | null;
  reportMeta?: { title: string; summary: string } | null;
  runId?: string | null;
}

export function AgentEventList({ events, userPrompt, reportUrl, reportMeta, runId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const items = groupEvents(events, userPrompt, {
    url: reportUrl ?? null,
    meta: reportMeta ?? null,
    runId: runId ?? null,
  });

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [items.length]);

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'visible' }}>
      {items.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '80px 20px',
            color: '#8e8ea0',
          }}
        >
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

      {items.map((item, idx) => {
        if (item.kind === 'user') {
          return (
            <div
              key={idx}
              style={{ display: 'flex', gap: 10, margin: '20px 0 24px', justifyContent: 'flex-end' }}
            >
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
                {item.content}
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

        if (item.kind === 'report') {
          return (
            <div key={idx} style={{ margin: '20px 0 8px', display: 'flex', gap: 12 }}>
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
                  reportUrl={item.reportUrl}
                  reportMeta={item.reportMeta}
                  runId={item.runId}
                  embedded
                />
              </div>
            </div>
          );
        }

        const turn = item;
        const turnEvents = turn.events;
        const thoughtEvents = turnEvents.filter(e => e.type === 'thought');
        const toolEvents = turnEvents.filter(e => e.type === 'tool_use' || e.type === 'tool_result');
        const textEvents = turnEvents.filter(e => e.type === 'text');
        const errorEvents = turnEvents.filter(e => e.type === 'error');

        return (
          <div key={idx} style={{ margin: '8px 0 24px', display: 'flex', gap: 12 }}>
            {/* ChatGPT同款方形圆角助手头像（蓝色） */}
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

            <div style={{ flex: 1, minWidth: 0 }}>
              {turn.startTime && (
                <Tooltip title={turn.startTime} placement="topLeft">
                  <Text type="secondary" style={{ fontSize: 11, color: '#9ca3af' }}>
                    <ClockCircleOutlined style={{ marginRight: 3 }} />
                    {formatTime(turn.startTime)}
                  </Text>
                </Tooltip>
              )}

              {/* 思考：默认折叠，ChatGPT同款极细框 */}
              {thoughtEvents.map((ev, i) => (
                <Accordion
                  key={`t${i}`}
                  label={
                    <span style={{ color: '#8e8ea0' }}>
                      思考
                      <span style={{ opacity: 0.7, marginLeft: 6, fontSize: 11 }}>
                        · {ev.content.length > 60 ? ev.content.slice(0, 60) + '…' : ev.content}
                      </span>
                    </span>
                  }
                  icon={
                    <BulbOutlined style={{ fontSize: 12 }} />
                  }
                  color="#9ca3af"
                >
                  <Paragraph
                    style={{
                      margin: 0,
                      color: '#6b7280',
                      fontSize: 13,
                      fontStyle: 'normal',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.6,
                    }}
                  >
                    {ev.content}
                  </Paragraph>
                </Accordion>
              ))}

              {/* 工具调用块：ChatGPT同款带彩色Tag */}
              {toolEvents.map((ev, i) => {
                const isToolUse = ev.type === 'tool_use';
                return (
                  <Accordion
                    key={`tool${i}`}
                    label={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: '#8e8ea0' }}>
                          {isToolUse ? '使用工具' : '执行结果'}
                        </span>
                        {ev.toolName && (
                          <Tag
                            color={isToolUse ? 'blue' : 'green'}
                            style={{ margin: 0, fontSize: 10, borderRadius: 4, padding: '0 6px', lineHeight: '18px' }}
                          >
                            {ev.toolName}
                          </Tag>
                        )}
                      </span>
                    }
                    icon={isToolUse
                      ? <CodeOutlined style={{ fontSize: 12 }} />
                      : <CheckCircleOutlined style={{ fontSize: 12 }} />}
                    color={isToolUse ? '#1a73e8' : '#10b981'}
                    defaultOpen={!isToolUse && i === 0}
                  >
                    {ev.content && (
                      <Paragraph style={{ margin: '0 0 4px', fontSize: 13, color: '#4b5563', whiteSpace: 'pre-wrap' }}>
                        {ev.content}
                      </Paragraph>
                    )}
                    {ev.toolInput && (
                      <div style={{ margin: '6px 0' }}>
                        <Text type="secondary" style={{ fontSize: 11 }}>输入参数</Text>
                        <CodeBlock text={ev.toolInput} color="#4b5563" />
                      </div>
                    )}
                    {ev.toolResult && (
                      <div style={{ margin: '6px 0' }}>
                        <Text type="secondary" style={{ fontSize: 11 }}>执行输出</Text>
                        <CodeBlock text={ev.toolResult} color="#065f46" />
                      </div>
                    )}
                  </Accordion>
                );
              })}

              {/* 助手文本输出：ChatGPT同款，无边框，纯文本 */}
              {textEvents.map((ev, i) => (
                <div
                  key={`text${i}`}
                  style={{
                    fontSize: 15,
                    lineHeight: 1.75,
                    color: '#374151',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    marginTop: thoughtEvents.length || toolEvents.length ? 8 : 4,
                    fontWeight: 400,
                  }}
                >
                  {ev.content}
                </div>
              ))}

              {/* 错误：ChatGPT同款红底卡片 */}
              {errorEvents.map((ev, i) => (
                <div
                  key={`err${i}`}
                  style={{
                    background: '#fef2f2',
                    border: '1px solid #fee2e2',
                    padding: '10px 12px',
                    borderRadius: 10,
                    fontSize: 13,
                    color: '#b91c1c',
                    marginTop: 8,
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.6,
                  }}
                >
                  <WarningOutlined style={{ marginRight: 6 }} />
                  {ev.content}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useRef, useEffect, useState } from 'react';
import { Typography, Collapse, Tooltip, Tag, Button } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  UserOutlined,
  RobotOutlined,
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

// 将事件流聚合为助手回合：连续的 thought/tool_use/tool_result/text 归为一个回合
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

  // 第一条：用户消息
  if (userPrompt) {
    items.push({ kind: 'user', content: userPrompt });
  }

  // 将事件按相邻类型聚合为助手回合
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

  // 报告作为最后一项
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

// 可折叠的思考/工具调用块
function CollapsibleBlock({
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
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textAlign: 'left',
          fontSize: 12,
          color: '#595959',
        }}
      >
        <span style={{ color }}>{icon}</span>
        <span>{label}</span>
        <span style={{ marginLeft: 'auto' }}>
          {open ? <UpOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 8px', fontSize: 12 }}>
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
        margin: 0,
        padding: 8,
        background: '#fafafa',
        borderRadius: 6,
        fontSize: 12,
        overflowX: 'auto',
        maxHeight: 240,
        color,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

interface AgentEventListProps {
  events: AgentEvent[];
  userPrompt: string;
  reportUrl?: string | null;
  reportMeta?: { title: string; summary: string } | null;
  runId?: string | null;
}

export function AgentEventList({ events, userPrompt, reportUrl, reportMeta, runId }: AgentEventListProps) {
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
    <div ref={containerRef} style={{ height: '100%', overflowY: 'auto', padding: '16px 0' }}>
      {items.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#86868b' }}>
          <RobotOutlined style={{ fontSize: 32, marginBottom: 12, display: 'block' }} />
          <Text type="secondary">开始一段新的策略研究对话</Text>
        </div>
      )}

      {items.map((item, idx) => {
        if (item.kind === 'user') {
          return (
            <div key={idx} style={{ display: 'flex', gap: 10, margin: '16px 24px', justifyContent: 'flex-end' }}>
              <div
                style={{
                  maxWidth: '70%',
                  background: '#1a73e8',
                  color: '#fff',
                  padding: '10px 14px',
                  borderRadius: '14px 14px 4px 14px',
                  fontSize: 14,
                  lineHeight: 1.7,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {item.content}
              </div>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#f0f5ff',
                  color: '#1a73e8',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <UserOutlined />
              </div>
            </div>
          );
        }

        if (item.kind === 'report') {
          return (
            <div key={idx} style={{ margin: '12px 24px', display: 'flex', gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#1a73e8',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <RobotOutlined />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid #f0f0f0',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
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
            </div>
          );
        }

        // 助手回合
        const turn = item;
        const turnEvents = turn.events;
        const thoughtEvents = turnEvents.filter(e => e.type === 'thought');
        const toolEvents = turnEvents.filter(e => e.type === 'tool_use' || e.type === 'tool_result');
        const textEvents = turnEvents.filter(e => e.type === 'text');
        const errorEvents = turnEvents.filter(e => e.type === 'error');

        return (
          <div key={idx} style={{ margin: '12px 24px', display: 'flex', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#1a73e8',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <RobotOutlined />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {turn.startTime && (
                <Tooltip title={turn.startTime}>
                  <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                    <ClockCircleOutlined style={{ marginRight: 3 }} />
                    {formatTime(turn.startTime)}
                  </Text>
                </Tooltip>
              )}

              {thoughtEvents.map((ev, i) => (
                <CollapsibleBlock
                  key={`t${i}`}
                  label={`思考 · ${ev.content.slice(0, 40)}${ev.content.length > 40 ? '...' : ''}`}
                  icon={<BulbOutlined />}
                  color="#86868b"
                >
                  <Paragraph style={{ margin: 0, color: '#595959', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
                    {ev.content}
                  </Paragraph>
                </CollapsibleBlock>
              ))}

              {toolEvents.map((ev, i) => {
                const isToolUse = ev.type === 'tool_use';
                return (
                  <CollapsibleBlock
                    key={`tool${i}`}
                    label={
                      <span>
                        {isToolUse ? '工具调用' : '执行结果'}
                        {ev.toolName && <Tag color={isToolUse ? 'blue' : 'success'} style={{ marginLeft: 6, fontSize: 11 }}>{ev.toolName}</Tag>}
                      </span>
                    }
                    icon={isToolUse ? <CodeOutlined /> : <CheckCircleOutlined />}
                    color={isToolUse ? '#1a73e8' : '#34a853'}
                  >
                    {ev.content && (
                      <Paragraph style={{ margin: '0 0 4px', whiteSpace: 'pre-wrap' }}>
                        {ev.content}
                      </Paragraph>
                    )}
                    {ev.toolInput && (
                      <div style={{ margin: '4px 0' }}>
                        <Text type="secondary" style={{ fontSize: 11 }}>输入</Text>
                        <CodeBlock text={ev.toolInput} color="#595959" />
                      </div>
                    )}
                    {ev.toolResult && (
                      <div style={{ margin: '4px 0' }}>
                        <Text type="secondary" style={{ fontSize: 11 }}>结果</Text>
                        <CodeBlock text={ev.toolResult} color="#34a853" />
                      </div>
                    )}
                  </CollapsibleBlock>
                );
              })}

              {textEvents.map((ev, i) => (
                <div
                  key={`text${i}`}
                  style={{
                    background: '#f7f7f8',
                    border: '1px solid #f0f0f0',
                    padding: '10px 14px',
                    borderRadius: '4px 14px 14px 14px',
                    fontSize: 14,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    margin: '6px 0',
                  }}
                >
                  {ev.content}
                </div>
              ))}

              {errorEvents.map((ev, i) => (
                <div
                  key={`err${i}`}
                  style={{
                    background: '#fff2f0',
                    border: '1px solid #ffccc7',
                    padding: '8px 12px',
                    borderRadius: 8,
                    fontSize: 13,
                    color: '#cf1322',
                    margin: '6px 0',
                    whiteSpace: 'pre-wrap',
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

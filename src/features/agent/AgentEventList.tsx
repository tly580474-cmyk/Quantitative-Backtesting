import { useRef, useEffect } from 'react';
import { Tag, Typography, Collapse, Tooltip } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  WarningOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import type { AgentEvent } from './types';

const { Text, Paragraph } = Typography;

function eventIcon(type: AgentEvent['type']) {
  switch (type) {
    case 'thought': return <BulbOutlined style={{ color: '#86868b' }} />;
    case 'tool_use': return <CodeOutlined style={{ color: '#1a73e8' }} />;
    case 'tool_result': return <CheckCircleOutlined style={{ color: '#34a853' }} />;
    case 'text': return <FileTextOutlined style={{ color: '#1a73e8' }} />;
    case 'error': return <WarningOutlined style={{ color: '#ea4335' }} />;
    default: return null;
  }
}

function eventColor(type: AgentEvent['type']): string {
  switch (type) {
    case 'thought': return 'default';
    case 'tool_use': return 'blue';
    case 'tool_result': return 'success';
    case 'text': return 'blue';
    case 'error': return 'error';
    default: return 'default';
  }
}

function eventLabel(type: AgentEvent['type']): string {
  switch (type) {
    case 'thought': return '思考';
    case 'tool_use': return '工具调用';
    case 'tool_result': return '执行结果';
    case 'text': return '输出';
    case 'error': return '错误';
    default: return type;
  }
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return '';
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
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

interface AgentEventListProps {
  events: AgentEvent[];
}

export function AgentEventList({ events }: AgentEventListProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events]);

  // Filter out 'done' type from display
  const visibleEvents = events.filter(e => e.type !== 'done');

  return (
    <div ref={containerRef} style={{ height: '100%', overflowY: 'auto', padding: '0 4px' }}>
      {visibleEvents.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#86868b' }}>
          等待 Agent 启动...
        </div>
      )}
      {visibleEvents.map((event, index) => {
        const stepNum = index + 1;
        const prevEvent = index > 0 ? visibleEvents[index - 1] : null;
        const duration = calcDuration(prevEvent?.timestamp, event.timestamp);

        return (
          <div
            key={index}
            style={{
              marginBottom: 8,
              paddingBottom: 8,
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 4,
                flexWrap: 'wrap',
              }}
            >
              <Text type="secondary" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                #{stepNum}
              </Text>
              {eventIcon(event.type)}
              <Tag color={eventColor(event.type)} style={{ margin: 0, fontSize: 11 }}>
                {eventLabel(event.type)}
              </Tag>
              {event.toolName && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {event.toolName}
                </Text>
              )}
              {event.timestamp && (
                <Tooltip title={event.timestamp}>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                    <ClockCircleOutlined style={{ marginRight: 2 }} />
                    {formatTime(event.timestamp)}
                  </Text>
                </Tooltip>
              )}
              {duration && (
                <Text type="secondary" style={{ fontSize: 11, color: '#1a73e8' }}>
                  +{duration}
                </Text>
              )}
            </div>
            <Paragraph
              style={{
                margin: 0,
                fontSize: 13,
                color: event.type === 'thought' ? '#86868b' : 'inherit',
                fontStyle: event.type === 'thought' ? 'italic' : 'normal',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {event.content}
            </Paragraph>
            {event.toolInput && (
              <Collapse
                ghost
                size="small"
                style={{ margin: '4px 0 0' }}
                items={[{
                  key: 'input',
                  label: <Text type="secondary" style={{ fontSize: 11 }}>输入</Text>,
                  children: (
                    <pre style={{
                      margin: 0,
                      padding: 8,
                      background: '#f5f5f5',
                      borderRadius: 6,
                      fontSize: 12,
                      overflowX: 'auto',
                      maxHeight: 200,
                    }}>
                      {event.toolInput}
                    </pre>
                  ),
                }]}
              />
            )}
            {event.toolResult && (
              <Collapse
                ghost
                size="small"
                style={{ margin: '4px 0 0' }}
                items={[{
                  key: 'result',
                  label: <Text type="secondary" style={{ fontSize: 11 }}>结果</Text>,
                  children: (
                    <pre style={{
                      margin: 0,
                      padding: 8,
                      background: '#f0f5ff',
                      borderRadius: 6,
                      fontSize: 12,
                      overflowX: 'auto',
                      maxHeight: 300,
                      color: '#34a853',
                    }}>
                      {event.toolResult}
                    </pre>
                  ),
                }]}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

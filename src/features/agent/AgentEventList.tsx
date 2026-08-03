import { useRef, useEffect } from 'react';
import { Tag, Typography } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  WarningOutlined,
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

  return (
    <div ref={containerRef} style={{ height: '100%', overflowY: 'auto', padding: '0 4px' }}>
      {events.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#86868b' }}>
          等待 Agent 启动...
        </div>
      )}
      {events.map((event, index) => (
        <div key={index} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {eventIcon(event.type)}
            <Tag color={eventColor(event.type)} style={{ margin: 0 }}>
              {eventLabel(event.type)}
            </Tag>
            {event.toolName && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {event.toolName}
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
            <pre style={{
              margin: '4px 0 0',
              padding: 8,
              background: '#f5f5f5',
              borderRadius: 6,
              fontSize: 12,
              overflowX: 'auto',
              maxHeight: 200,
            }}>
              {event.toolInput}
            </pre>
          )}
          {event.toolResult && (
            <pre style={{
              margin: '4px 0 0',
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
          )}
        </div>
      ))}
    </div>
  );
}

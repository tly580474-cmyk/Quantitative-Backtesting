import { useState, useCallback } from 'react';
import { Input, Button, Space, Typography, Card, Row, Col, Tag, App, InputNumber } from 'antd';
import { PlayCircleOutlined, StopOutlined, RobotOutlined } from '@ant-design/icons';
import { AgentEventList, calcDuration } from './AgentEventList';
import { AgentReportView } from './AgentReportView';
import { useAgentStream } from './useAgentStream';
import { createAgentRun, cancelAgentRun } from './api';

const { TextArea } = Input;
const { Title, Text } = Typography;

export default function AgentRunner() {
  const [prompt, setPrompt] = useState('');
  const [maxTurns, setMaxTurns] = useState(50);
  const [runId, setRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();
  const { state, connect, disconnect } = useAgentStream();

  const handleStart = useCallback(async () => {
    if (prompt.trim().length < 10) {
      message.warning('请输入至少 10 个字符的策略描述');
      return;
    }
    setLoading(true);
    try {
      const result = await createAgentRun(prompt, maxTurns);
      setRunId(result.runId);
      connect(result.runId);
      message.success('Agent 已启动');
    } catch (err) {
      message.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [prompt, maxTurns, connect, message]);

  const handleCancel = useCallback(async () => {
    if (!runId) return;
    try {
      await cancelAgentRun(runId);
      message.info('已发送取消信号');
    } catch {
      message.error('取消失败');
    }
  }, [runId, message]);

  const handleReset = useCallback(() => {
    disconnect();
    setRunId(null);
    setPrompt('');
  }, [disconnect]);

  const statusColor = {
    idle: 'default',
    connecting: 'processing',
    running: 'processing',
    completed: 'success',
    failed: 'error',
    canceled: 'warning',
  };

  const statusText = {
    idle: '待机',
    connecting: '连接中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消',
  };

  // 计算步骤数和总耗时
  const stepCount = state.events.filter(e => e.type !== 'done').length;
  const firstEvent = state.events.find(e => e.timestamp);
  const lastEvent = [...state.events].reverse().find(e => e.timestamp);
  const totalDuration =
    firstEvent && lastEvent && firstEvent.timestamp && lastEvent.timestamp
      ? calcDuration(firstEvent.timestamp, lastEvent.timestamp)
      : '';

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RobotOutlined style={{ fontSize: 20, color: '#1a73e8' }} />
            <Title level={4} style={{ margin: 0 }}>策略研究智能体</Title>
            {state.status !== 'idle' && (
              <Tag color={statusColor[state.status]}>
                {statusText[state.status]}
              </Tag>
            )}
          </div>
          <TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述你的策略研究需求，例如：&#10;分析动量因子（momentum_20）在 2025 年 5-6 月的有效性，计算 IC、ICIR 和分层收益，并与反转因子做对比..."
            autoSize={{ minRows: 3, maxRows: 6 }}
            disabled={state.status === 'running' || state.status === 'connecting'}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <Text type="secondary">最大轮次:</Text>
              <InputNumber
                value={maxTurns}
                onChange={(v) => setMaxTurns(v ?? 50)}
                min={1}
                max={200}
                style={{ width: 80 }}
                disabled={state.status === 'running' || state.status === 'connecting'}
              />
            </Space>
            <Space>
              {state.status === 'running' || state.status === 'connecting' ? (
                <>
                  <Button danger icon={<StopOutlined />} onClick={handleCancel}>
                    取消
                  </Button>
                  <Button onClick={handleReset}>重置</Button>
                </>
              ) : (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={handleStart}
                  loading={loading}
                  disabled={prompt.trim().length < 10}
                >
                  启动 Agent
                </Button>
              )}
            </Space>
          </div>
        </Space>
      </Card>

      {state.status !== 'idle' && (
        <Row gutter={16} style={{ flex: 1, minHeight: 0 }}>
          <Col span={10}>
            <Card
              title={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>实时步骤</span>
                  <Space size="small">
                    {stepCount > 0 && (
                      <Text type="secondary" style={{ fontSize: 12 }}>{stepCount} 步</Text>
                    )}
                    {totalDuration && (
                      <Text type="secondary" style={{ fontSize: 12, color: '#1a73e8' }}>
                        耗时 {totalDuration}
                      </Text>
                    )}
                  </Space>
                </div>
              }
              size="small"
              styles={{ body: { height: 'calc(100% - 40px)', overflow: 'hidden' } }}
              style={{ height: '100%' }}
            >
              <AgentEventList events={state.events} />
            </Card>
          </Col>
          <Col span={14}>
            <Card
              title="报告预览"
              size="small"
              styles={{ body: { height: 'calc(100% - 40px)', padding: 0 } }}
              style={{ height: '100%' }}
            >
              <AgentReportView
                reportUrl={state.reportUrl}
                reportMeta={state.reportMeta}
                runId={runId}
              />
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}

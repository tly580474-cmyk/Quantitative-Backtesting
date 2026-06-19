import { useState } from 'react';
import {
  Drawer, Button, Input, Typography, Space, Alert,
  Tag, Spin, Result, Divider, message,
} from 'antd';
import { BulbOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { getAIStatus, generateStrategy } from './api';
import type { AIStatus, GenerateStrategyResult } from './types';
import { useStrategyStudioStore } from '@/stores/useStrategyStudioStore';
import { validateDocument } from '@/features/visualStrategies/validator';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function GenerateStrategyDrawer({ open, onClose }: Props) {
  const [prompt, setPrompt] = useState('');
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateStrategyResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const importDocument = useStrategyStudioStore((s) => s.importDocument);

  const checkStatus = async () => {
    setStatusLoading(true);
    try {
      const status = await getAIStatus();
      setAiStatus(status);
      if (!status.configured && !status.enabled) {
        message.info('AI 功能未配置，使用 Mock 模式演示');
      }
    } catch {
      setAiStatus({ enabled: true, configured: false, provider: 'mock' });
      message.info('无法连接 AI 服务，使用本地 Mock 模式');
    } finally {
      setStatusLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setGenError(null);
    setResult(null);

    try {
      let res;

      // If server is not configured, use local mock directly
      if (aiStatus && !aiStatus.configured) {
        const { localGenerate } = await import('./localMock');
        res = await localGenerate(prompt.trim());
      } else {
        // Try server; fall back to local mock on failure
        try {
          res = await generateStrategy({
            prompt: prompt.trim(),
            dslVersion: '1.0',
          });
        } catch {
          const { localGenerate } = await import('./localMock');
          res = await localGenerate(prompt.trim());
          message.info('AI 服务不可用，已使用本地 Mock 模式生成');
        }
      }

      // Validate the returned strategy
      const vr = validateDocument(res.strategy);
      if (!vr.valid) {
        setGenError(`AI 返回的策略校验失败: ${vr.errors.map((e) => e.message).join('; ')}`);
        setGenerating(false);
        return;
      }

      setResult(res);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = () => {
    if (!result) return;
    importDocument(result.strategy);
    message.success('AI 生成策略已导入到编辑器，请确认后保存');
    onClose();
  };

  // Check status on open
  const handleOpen = () => {
    checkStatus();
  };

  return (
    <Drawer
      title={
        <Space>
          <BulbOutlined />
          AI 生成策略
          {aiStatus && (
            <Tag color={aiStatus.configured ? 'green' : 'orange'}>
              {aiStatus.configured ? '已配置' : 'Mock 演示'}
            </Tag>
          )}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={480}
      afterOpenChange={(visible) => { if (visible) handleOpen(); }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Status info */}
        {aiStatus && !aiStatus.configured && (
          <Alert
            type="info"
            message="AI 未配置"
            description={
              <span>
                OpenAI API 密钥未设置。当前使用 <strong>Mock 演示模式</strong>，返回示例策略。
                配置方法：在 <code>server/.env</code> 中设置 <code>AI_STRATEGY_ENABLED=true</code> 和 <code>OPENAI_API_KEY=your-key</code>。
              </span>
            }
            showIcon
          />
        )}

        {/* Prompt input */}
        <div>
          <Text strong>策略描述</Text>
          <Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0' }}>
            用自然语言描述你的交易策略，例如："5 日均线上穿 20 日均线且 RSI 小于 70 时买入，下穿时卖出，止损 8%"
          </Paragraph>
          <TextArea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述你的策略..."
            maxLength={2000}
            showCount
          />
        </div>

        <Button
          type="primary"
          block
          icon={<BulbOutlined />}
          loading={generating}
          onClick={handleGenerate}
          disabled={!prompt.trim()}
        >
          生成策略
        </Button>

        {/* Loading */}
        {generating && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin tip="AI 正在生成策略..." />
          </div>
        )}

        {/* Error */}
        {genError && (
          <Alert type="error" message="生成失败" description={genError} showIcon closable />
        )}

        {/* Result */}
        {result && (
          <div>
            <Divider />
            <Result
              status="success"
              title="策略已生成"
              subTitle={result.summary}
              style={{ padding: '16px 0' }}
            />

            {result.warnings.length > 0 && (
              <Alert
                type="warning"
                message="注意事项"
                description={result.warnings.map((w, i) => (
                  <div key={i}>• {w}</div>
                ))}
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}

            <Space>
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleApply}>
                导入到编辑器
              </Button>
              <Button onClick={() => setResult(null)}>
                重新生成
              </Button>
            </Space>
          </div>
        )}
      </Space>
    </Drawer>
  );
}

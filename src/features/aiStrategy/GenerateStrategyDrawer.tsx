import { useState } from 'react';
import {
  Drawer, Button, Input, Select, Segmented, Typography, Space, Alert,
  Tag, Spin, Result, Divider, message,
} from 'antd';
import { BulbOutlined, CheckCircleOutlined, EditOutlined } from '@ant-design/icons';
import { getAIStatus, generateStrategy, refineStrategy } from './api';
import type { AIStatus, GenerateStrategyResult } from './types';
import { useStrategyStudioStore } from '@/stores/useStrategyStudioStore';
import { validateDocument } from '@/features/visualStrategies/validator';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

type GenerationMode = 'generate' | 'refine';

export default function GenerateStrategyDrawer({ open, onClose }: Props) {
  const [mode, setMode] = useState<GenerationMode>('generate');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('deepseek-v4-flash');
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateStrategyResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const importDocument = useStrategyStudioStore((s) => s.importDocument);
  const currentDocument = useStrategyStudioStore((s) => s.document);
  const updateDocument = useStrategyStudioStore((s) => s.updateDocument);

  const checkStatus = async () => {
    setStatusLoading(true);
    try {
      const status = await getAIStatus();
      setAiStatus(status);
      if (status.currentModel) setModel(status.currentModel);
      if (!status.configured && !status.enabled) {
        message.info('AI 功能未配置，使用 Mock 模式演示');
      }
    } catch {
      setAiStatus({
        enabled: true, configured: false, provider: 'mock',
        currentModel: 'mock', availableModels: [],
      });
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
      if (mode === 'refine' && !currentDocument) {
        throw new Error('当前没有可修改的策略');
      }

      // If server is not configured, use local mock directly
      if (aiStatus && !aiStatus.configured) {
        const { localGenerate, localRefine } = await import('./localMock');
        res = mode === 'refine'
          ? await localRefine(currentDocument!, prompt.trim())
          : await localGenerate(prompt.trim());
      } else {
        // Try server; fall back to local mock on failure
        try {
          res = mode === 'refine'
            ? await refineStrategy({
                currentStrategy: currentDocument!,
                modification: prompt.trim(),
                model,
                dslVersion: '1.0',
              })
            : await generateStrategy({
                prompt: prompt.trim(),
                model,
                dslVersion: '1.0',
              });
        } catch {
          const { localGenerate, localRefine } = await import('./localMock');
          res = mode === 'refine'
            ? await localRefine(currentDocument!, prompt.trim())
            : await localGenerate(prompt.trim());
          message.info(`AI 服务不可用，已使用本地 Mock 模式${mode === 'refine' ? '生成修改草稿' : '生成策略'}`);
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
    if (mode === 'refine' && currentDocument) {
      updateDocument((draft) => {
        Object.assign(draft, result.strategy, {
          id: currentDocument.id,
          strategyVersion: currentDocument.strategyVersion,
          metadata: {
            ...result.strategy.metadata,
            createdAt: currentDocument.metadata.createdAt,
          },
        });
      });
      message.success('AI 修改草稿已应用，请确认后保存');
    } else {
      importDocument(result.strategy);
      message.success('AI 生成策略已导入到编辑器，请确认后保存');
    }
    onClose();
  };

  const handleModeChange = (nextMode: GenerationMode) => {
    setMode(nextMode);
    setPrompt('');
    setResult(null);
    setGenError(null);
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
        <Segmented<GenerationMode>
          block
          value={mode}
          onChange={handleModeChange}
          options={[
            { label: '新建策略', value: 'generate', icon: <BulbOutlined /> },
            { label: '改动现有策略', value: 'refine', icon: <EditOutlined /> },
          ]}
        />

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

        {mode === 'refine' && currentDocument && (
          <Alert
            type="info"
            showIcon
            title={`基于当前策略：${currentDocument.name}`}
            description={`版本 ${currentDocument.strategyVersion}。AI 只生成修改草稿，确认应用后仍需手动保存或发布。`}
          />
        )}

        {/* Prompt input */}
        <div>
          <Text strong>{mode === 'refine' ? '修改要求' : '策略描述'}</Text>
          <Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0' }}>
            {mode === 'refine'
              ? '说明希望如何调整当前策略，例如：“将止损改为 6%，并增加 RSI24 小于 35 的买入条件”'
              : '用自然语言描述你的交易策略，例如：“5 日均线上穿 20 日均线且 RSI 小于 70 时买入，下穿时卖出，止损 8%”'}
          </Paragraph>
          <TextArea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={mode === 'refine' ? '描述对当前策略的修改要求...' : '描述你的策略...'}
            maxLength={2000}
            showCount
            aria-label={mode === 'refine' ? '策略修改要求' : '策略描述'}
          />
        </div>

        {/* Model selector */}
        {aiStatus?.configured && aiStatus.availableModels.length > 0 && (
          <div>
            <Text strong style={{ fontSize: 12 }}>模型</Text>
            <Select
              value={model}
              onChange={setModel}
              style={{ width: '100%', marginTop: 4 }}
              options={aiStatus.availableModels.map((m) => ({ label: m, value: m }))}
            />
          </div>
        )}

        <Button
          type="primary"
          block
          icon={mode === 'refine' ? <EditOutlined /> : <BulbOutlined />}
          loading={generating}
          onClick={handleGenerate}
          disabled={!prompt.trim() || (mode === 'refine' && !currentDocument)}
        >
          {mode === 'refine' ? '生成修改草稿' : '生成策略'}
        </Button>

        {/* Loading */}
        {generating && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin tip={mode === 'refine' ? 'AI 正在修改策略...' : 'AI 正在生成策略...'} />
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
              title={mode === 'refine' ? '修改草稿已生成' : '策略已生成'}
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
                {mode === 'refine' ? '应用修改草稿' : '导入到编辑器'}
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

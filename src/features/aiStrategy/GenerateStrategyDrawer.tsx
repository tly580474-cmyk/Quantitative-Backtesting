import { useRef, useState } from 'react';
import {
  Drawer, Button, Input, Select, Segmented, Typography, Space, Alert,
  Tag, Spin, Divider, Card, App,
} from 'antd';
import { BulbOutlined, CheckCircleOutlined, EditOutlined } from '@ant-design/icons';
import { getAIStatus, generateStrategy, refineStrategy } from './api';
import type { AIStatus, GenerateStrategyResult } from './types';
import { useStrategyStudioStore } from '@/stores/useStrategyStudioStore';
import { validateDocument } from '@/features/visualStrategies/validator';
import { explainStrategy as explainVisualStrategy } from '@/features/visualStrategies/explainer';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

type GenerationMode = 'generate' | 'refine';

interface BoundGenerationResult {
  data: GenerateStrategyResult;
  mode: GenerationMode;
}

function StrategyDraftSummary({
  result,
  mode,
}: {
  result: GenerateStrategyResult;
  mode: GenerationMode;
}) {
  const { strategy } = result;

  return (
    <Card
      size="small"
      className="ai-strategy-summary"
      title={
        <Space wrap>
          <Text strong>策略摘要</Text>
          <Tag color="success" icon={<CheckCircleOutlined />}>校验通过</Tag>
          <Tag>{mode === 'refine' ? '修改草稿' : '新策略草稿'}</Tag>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{strategy.name}</Typography.Title>
          {strategy.description && (
            <Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
              {strategy.description}
            </Paragraph>
          )}
        </div>

        <Space wrap size={[6, 6]}>
          <Tag color="blue">指标 {strategy.indicators.length}</Tag>
          <Tag color="cyan">参数 {strategy.parameters.length}</Tag>
          <Tag color="orange">风控 {strategy.risk.length}</Tag>
          <Tag>版本 {strategy.strategyVersion}</Tag>
        </Space>

        <pre className="ai-strategy-summary-text">
          {explainVisualStrategy(strategy)}
        </pre>

        <Text type="secondary" style={{ fontSize: 12 }}>{result.summary}</Text>
      </Space>
    </Card>
  );
}

export default function GenerateStrategyDrawer({ open, onClose }: Props) {
  const { message, modal } = App.useApp();
  const [mode, setMode] = useState<GenerationMode>('generate');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('deepseek-v4-flash');
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<BoundGenerationResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  const importDocument = useStrategyStudioStore((s) => s.importDocument);
  const currentDocument = useStrategyStudioStore((s) => s.document);
  const updateDocument = useStrategyStudioStore((s) => s.updateDocument);
  const isDirty = useStrategyStudioStore((s) => s.isDirty);

  const checkStatus = async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const status = await getAIStatus();
      setAiStatus(status);
      if (status.currentModel) setModel(status.currentModel);
      if (!status.configured) {
        message.info('AI 功能未配置，当前为 Mock 演示模式');
      }
    } catch (err) {
      setAiStatus({
        enabled: false, configured: false, provider: 'local-mock',
        currentModel: 'mock', availableModels: [],
      });
      setModel('mock');
      setStatusError(err instanceof Error ? err.message : '无法连接 AI 服务');
      message.warning('无法连接 AI 服务，已切换到明确标识的本地 Mock 模式');
    } finally {
      setStatusLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setGenError(null);
    setResult(null);

    const requestMode = mode;
    const requestDocument = currentDocument;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;

    try {
      let res: GenerateStrategyResult;
      if (requestMode === 'refine' && !requestDocument) {
        throw new Error('当前没有可修改的策略');
      }

      const useLocalMock = aiStatus?.provider === 'mock' || aiStatus?.provider === 'local-mock';
      if (useLocalMock) {
        const { localGenerate, localRefine } = await import('./localMock');
        res = requestMode === 'refine'
          ? await localRefine(requestDocument!, prompt.trim())
          : await localGenerate(prompt.trim());
      } else {
        res = requestMode === 'refine'
          ? await refineStrategy({
              currentStrategy: requestDocument!,
              modification: prompt.trim(),
              model,
              dslVersion: '1.0',
            }, controller.signal)
          : await generateStrategy({
              prompt: prompt.trim(),
              model,
              dslVersion: '1.0',
            }, controller.signal);
      }

      if (controller.signal.aborted) return;

      // Validate the returned strategy
      const vr = validateDocument(res.strategy);
      if (!vr.valid) {
        setGenError(`AI 返回的策略校验失败: ${vr.errors.map((e) => e.message).join('; ')}`);
        return;
      }

      setResult({ data: res, mode: requestMode });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        message.info('已取消策略生成');
        return;
      }
      setGenError(err instanceof Error ? err.message : '生成失败');
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
      setGenerating(false);
    }
  };

  const applyResult = () => {
    if (!result) return;
    if (result.mode === 'refine' && currentDocument) {
      updateDocument((draft) => {
        Object.assign(draft, result.data.strategy, {
          id: currentDocument.id,
          strategyVersion: currentDocument.strategyVersion,
          metadata: {
            ...result.data.strategy.metadata,
            createdAt: currentDocument.metadata.createdAt,
          },
        });
      });
      message.success('AI 修改草稿已应用，请确认后保存');
    } else {
      importDocument(result.data.strategy);
      message.success('AI 生成策略已导入到编辑器，请确认后保存');
    }
    onClose();
  };

  const handleApply = () => {
    if (!result) return;
    if (result.mode === 'generate' && isDirty) {
      modal.confirm({
        title: '替换当前未保存策略？',
        content: '导入 AI 新策略会替换当前编辑内容，并清空当前撤销历史。建议先保存当前草稿。',
        okText: '仍要替换',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: applyResult,
      });
      return;
    }
    applyResult();
  };

  const handleModeChange = (nextMode: GenerationMode) => {
    if (generating) return;
    setMode(nextMode);
    setPrompt('');
    setResult(null);
    setGenError(null);
  };

  // Check status on open
  const handleOpen = () => {
    checkStatus();
  };

  const handleCancelGeneration = () => {
    requestControllerRef.current?.abort();
  };

  const handleClose = () => {
    requestControllerRef.current?.abort();
    onClose();
  };

  return (
    <Drawer
      title={
        <Space>
          <BulbOutlined />
          AI 生成策略
          {aiStatus && (
            <Tag color={aiStatus.configured ? 'green' : 'orange'}>
              {aiStatus.configured
                ? '已配置'
                : aiStatus.provider === 'local-mock'
                  ? '本地 Mock'
                  : 'Mock 演示'}
            </Tag>
          )}
        </Space>
      }
      open={open}
      onClose={handleClose}
      width={480}
      afterOpenChange={(visible) => { if (visible) handleOpen(); }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Segmented<GenerationMode>
          block
          value={mode}
          disabled={generating}
          onChange={handleModeChange}
          options={[
            { label: '新建策略', value: 'generate', icon: <BulbOutlined /> },
            { label: '改动现有策略', value: 'refine', icon: <EditOutlined /> },
          ]}
        />

        {/* Status info */}
        {aiStatus && !aiStatus.configured && (
          <Alert
            type={statusError ? 'warning' : 'info'}
            message={statusError ? 'AI 服务不可用，当前使用本地 Mock' : 'AI 未配置'}
            description={
              <span>
                {statusError
                  ? `${statusError}。Mock 结果会明确标识，仅用于界面演示。`
                  : (
                    <>
                      OpenAI API 密钥未设置。当前使用 <strong>Mock 演示模式</strong>，返回示例策略。
                      配置方法：在 <code>server/.env</code> 中设置 <code>AI_STRATEGY_ENABLED=true</code> 和 <code>OPENAI_API_KEY=your-key</code>。
                    </>
                  )}
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
            disabled={generating}
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
              disabled={generating}
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
          disabled={statusLoading || !aiStatus || !prompt.trim() || (mode === 'refine' && !currentDocument)}
        >
          {mode === 'refine' ? '生成修改草稿' : '生成策略'}
        </Button>

        {/* Loading */}
        {generating && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Space direction="vertical">
              <Spin tip={mode === 'refine' ? 'AI 正在修改策略...' : 'AI 正在生成策略...'} />
              <Button danger onClick={handleCancelGeneration}>取消生成</Button>
            </Space>
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
            <StrategyDraftSummary result={result.data} mode={result.mode} />

            {result.data.warnings.length > 0 && (
              <Alert
                type="warning"
                message="注意事项"
                description={result.data.warnings.map((w, i) => (
                  <div key={i}>• {w}</div>
                ))}
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}

            <Space>
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleApply}>
                {result.mode === 'refine' ? '应用修改草稿' : '导入到编辑器'}
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

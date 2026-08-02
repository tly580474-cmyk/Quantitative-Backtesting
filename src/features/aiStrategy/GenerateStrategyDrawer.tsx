import { useRef, useState } from 'react';
import {
  Drawer, Button, Input, Select, Segmented, Typography, Space, Alert,
  Tag, Spin, Divider, Card, App, Row, Col, Checkbox,
} from 'antd';
import { BulbOutlined, CheckCircleOutlined, EditOutlined } from '@ant-design/icons';
import { getAIStatus, generateStrategy, refineStrategy, toAIUserMessage } from './api';
import { interpretError, type ErrorInterpretation } from './errorInterpreter';
import type {
  AIStatus,
  GenerateStrategyResult,
  StrategyConfirmationDraft,
} from './types';
import { useStrategyStudioStore } from '@/stores/useStrategyStudioStore';
import { validateDocument } from '@/features/visualStrategies/validator';
import { explainStrategy as explainVisualStrategy } from '@/features/visualStrategies/explainer';
import { buildLocalConfirmationDraft } from './confirmation';
import {
  confirmExperimentVersion,
  getExperimentCapabilityVersion,
} from '@/features/experiments/api';

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

/** N4：生成失败的结构化错误（后端已按九类错误码分类）。 */
interface StructuredGenError {
  message: string;
  category?: string;
  categoryLabel?: string;
  fieldPaths?: string[];
  issues?: string[];
}

function toStructuredError(err: unknown): StructuredGenError {
  const message = toAIUserMessage(err);
  const details = (err as {
    details?: { category?: string; categoryLabel?: string; fieldPaths?: string[]; issues?: string[] };
  }).details;
  if (details && typeof details.category === 'string') {
    return {
      message,
      category: details.category,
      categoryLabel: details.categoryLabel,
      fieldPaths: Array.isArray(details.fieldPaths) ? details.fieldPaths : undefined,
      issues: Array.isArray(details.issues) ? details.issues : undefined,
    };
  }
  return { message };
}

function StrategyConfirmationPanel({
  confirmation,
  confirmedIds,
  onToggle,
}: {
  confirmation: StrategyConfirmationDraft;
  confirmedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <Card
      size="small"
      className="strategy-confirmation-panel"
      title="生成前语义确认"
      extra={<Tag color="gold">不写入策略逻辑</Tag>}
    >
      <Row gutter={[12, 12]} align="stretch">
        <Col xs={24} lg={8}>
          <section className="strategy-confirmation-column">
            <Text strong>1. 原始描述</Text>
            <Paragraph className="strategy-confirmation-source">
              {confirmation.sourceText}
            </Paragraph>
          </section>
        </Col>
        <Col xs={24} lg={8}>
          <section className="strategy-confirmation-column">
            <Text strong>2. 结构化抽取</Text>
            <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 10 }}>
              {confirmation.extractedFields.map((field) => (
                <div className="strategy-confirmation-field" key={field.key}>
                  <Text type="secondary">{field.label}</Text>
                  <Text>{field.value}</Text>
                  <Tag bordered={false}>{field.evidencePath}</Tag>
                </div>
              ))}
            </Space>
          </section>
        </Col>
        <Col xs={24} lg={8}>
          <section className="strategy-confirmation-column">
            <Text strong>3. 显式假设</Text>
            <Paragraph type="secondary" style={{ margin: '4px 0 10px' }}>
              逐项点选确认；假设不会被 Repair Middleware 写入交易规则。
            </Paragraph>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {confirmation.assumptions.map((assumption) => (
                <Checkbox
                  key={assumption.id}
                  checked={confirmedIds.includes(assumption.id)}
                  onChange={(event) => onToggle(assumption.id, event.target.checked)}
                  className="strategy-assumption-option"
                >
                  <Space direction="vertical" size={2}>
                    <Text strong>{assumption.label}</Text>
                    <Text>{assumption.selectedValue}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{assumption.reason}</Text>
                  </Space>
                </Checkbox>
              ))}
            </Space>
          </section>
        </Col>
      </Row>
    </Card>
  );
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
  const [genError, setGenError] = useState<StructuredGenError | null>(null);
  const [interpretation, setInterpretation] = useState<ErrorInterpretation | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [confirmedAssumptionIds, setConfirmedAssumptionIds] = useState<string[]>([]);
  const [freezingExperiment, setFreezingExperiment] = useState(false);
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

  const handleGenerate = async (overridePrompt?: string) => {
    const effectivePrompt = overridePrompt ?? prompt;
    if (!effectivePrompt.trim()) return;
    setGenerating(true);
    setGenError(null);
    setInterpretation(null);
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
          ? await localRefine(requestDocument!, effectivePrompt.trim())
          : await localGenerate(effectivePrompt.trim());
      } else {
        res = requestMode === 'refine'
          ? await refineStrategy({
              currentStrategy: requestDocument!,
              modification: effectivePrompt.trim(),
              model,
              dslVersion: '1.0',
            }, controller.signal)
          : await generateStrategy({
              prompt: effectivePrompt.trim(),
              model,
              dslVersion: '1.0',
            }, controller.signal);
      }

      if (controller.signal.aborted) return;

      // Rolling-deploy compatibility: an older server may not return the M1
      // confirmation contract yet. Derive the same deterministic view from
      // the validated DSL instead of crashing or asking another model.
      if (!res.confirmation) {
        res = {
          ...res,
          confirmation: buildLocalConfirmationDraft(effectivePrompt.trim(), res.strategy),
        };
      }

      // Validate the returned strategy
      const vr = validateDocument(res.strategy);
      if (!vr.valid) {
        setGenError({
          message: `AI 返回的策略校验失败: ${vr.errors.map((e) => e.message).join('; ')}`,
          category: 'SCHEMA_INVALID',
          categoryLabel: 'Schema 校验失败',
          fieldPaths: vr.errors.map((e) => e.path).filter((path): path is string => Boolean(path)),
        });
        return;
      }

      setResult({ data: res, mode: requestMode });
      setConfirmedAssumptionIds([]);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        message.info('已取消策略生成');
        return;
      }
      setGenError(toStructuredError(err));
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
      setGenerating(false);
    }
  };

  const handleInterpret = async () => {
    if (!genError?.category) return;
    setInterpreting(true);
    try {
      const interpretationResult = await interpretError({
        category: genError.category,
        issues: genError.issues,
        fieldPaths: genError.fieldPaths,
        prompt,
      });
      setInterpretation(interpretationResult);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '智能解释失败');
    } finally {
      setInterpreting(false);
    }
  };

  const applySuggestion = (patch: string) => {
    // N4.3 重提闭环：点选建议 → 预填 prompt → 自动重新生成
    setInterpretation(null);
    const nextPrompt = `${prompt.trim()} ${patch.trim()}`.trim();
    setPrompt(nextPrompt);
    setTimeout(() => void handleGenerate(nextPrompt), 0);
  };

  const applyResult = async () => {
    if (!result) return;
    setFreezingExperiment(true);
    try {
      const capabilityVersion = await getExperimentCapabilityVersion();
      const strategyToFreeze = result.mode === 'refine' && currentDocument
        ? {
            ...result.data.strategy,
            id: currentDocument.id,
            strategyVersion: currentDocument.strategyVersion,
            metadata: {
              ...result.data.strategy.metadata,
              createdAt: currentDocument.metadata.createdAt,
            },
          }
        : result.data.strategy;
      const frozen = await confirmExperimentVersion({
        generationId: result.data.generationId,
        name: result.data.strategy.name,
        sourceText: result.data.confirmation.sourceText,
        strategy: strategyToFreeze,
        confirmation: {
          ...result.data.confirmation,
          assumptions: result.data.confirmation.assumptions.map((assumption) => ({
            ...assumption,
            confirmed: confirmedAssumptionIds.includes(assumption.id),
          })),
        },
        capabilityVersion,
      });
      const governedStrategy = {
        ...strategyToFreeze,
        metadata: {
          ...strategyToFreeze.metadata,
          experimentVersionId: frozen.experimentVersion.id,
        },
      };
      if (result.mode === 'refine' && currentDocument) {
        updateDocument((draft) => {
          Object.assign(draft, governedStrategy);
        });
        message.success('实验版本已冻结，AI 修改草稿已应用');
      } else {
        importDocument(governedStrategy);
        message.success('实验版本已冻结，策略已导入编辑器');
      }
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '冻结实验版本失败');
    } finally {
      setFreezingExperiment(false);
    }
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
    setInterpretation(null);
    setConfirmedAssumptionIds([]);
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
      size={1120}
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
          onClick={() => handleGenerate()}
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
          <Alert
            type="error"
            message={genError.category ? (genError.categoryLabel ?? genError.category) : '生成失败'}
            description={(
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Text>{genError.message}</Text>
                {genError.fieldPaths && genError.fieldPaths.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    涉及字段：{genError.fieldPaths.join('、')}
                  </Text>
                )}
                {genError.category && (
                  <Button
                    size="small"
                    loading={interpreting}
                    onClick={() => void handleInterpret()}
                  >
                    智能解释与修正建议
                  </Button>
                )}
                {interpretation && (
                  <Card size="small" title="修正建议（只建议，不自动修改策略）">
                    <Paragraph style={{ marginBottom: 8 }}>{interpretation.explanation}</Paragraph>
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      {interpretation.suggestions.map((suggestion) => (
                        <Button
                          key={suggestion.id}
                          size="small"
                          type="primary"
                          ghost
                          block
                          onClick={() => applySuggestion(suggestion.promptPatch)}
                        >
                          {suggestion.label}
                        </Button>
                      ))}
                    </Space>
                  </Card>
                )}
              </Space>
            )}
            showIcon
            closable
          />
        )}

        {/* Result */}
        {result && (
          <div>
            <Divider />
            <StrategyConfirmationPanel
              confirmation={result.data.confirmation}
              confirmedIds={confirmedAssumptionIds}
              onToggle={(id, checked) => {
                setConfirmedAssumptionIds((current) => (
                  checked
                    ? [...new Set([...current, id])]
                    : current.filter((item) => item !== id)
                ));
              }}
            />

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
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                onClick={handleApply}
                loading={freezingExperiment}
                disabled={result.data.confirmation.assumptions.some(
                  (item) => item.required && !confirmedAssumptionIds.includes(item.id),
                )}
              >
                {result.mode === 'refine' ? '冻结实验并应用修改' : '冻结实验并导入编辑器'}
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

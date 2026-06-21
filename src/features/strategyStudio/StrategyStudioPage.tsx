import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card, Row, Col, Button, Space, Input, Select, InputNumber,
  Typography, Divider, Empty, Tag, Tooltip, Popconfirm,
  message, Drawer, List, Collapse, Badge, Table, Progress, Alert,
} from 'antd';
import {
  PlusOutlined, SaveOutlined, UndoOutlined, RedoOutlined,
  PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ExportOutlined, ImportOutlined, DeleteOutlined, CopyOutlined,
  EditOutlined, BulbOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { useStrategyStudioStore } from '@/stores/useStrategyStudioStore';
import { explainStrategy } from '@/features/visualStrategies/explainer';
import { validateDocument } from '@/features/visualStrategies/validator';
import { INDICATOR_REGISTRY } from '@/features/indicators/registry';
import { getRepository } from '@/api/useRepository';
import {
  downloadStrategyFile,
  parseImportedStrategy,
} from '@/db/visualStrategyRepository';
import type {
  VisualStrategyDocument,
  ConditionRule,
  RuleGroup,
  Operand,
  CompareOperator,
  IndicatorNode,
  RiskRule,
  StrategyParameter,
} from '@/features/visualStrategies/types';
import GenerateStrategyDrawer from '@/features/aiStrategy/GenerateStrategyDrawer';
import { useStrategyPreview } from './useStrategyPreview';
import { useCandleStore } from '@/stores/useCandleStore';

const { Text, Title } = Typography;
const { TextArea } = Input;

// ---- Node type colors ----

const OPERATOR_LABELS: Record<CompareOperator, string> = {
  gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=',
  crossesAbove: '上穿', crossesBelow: '下穿', between: '介于',
};

const MARKET_FIELD_LABELS: Record<string, string> = {
  open: '开盘价', high: '最高价', low: '最低价', close: '收盘价', volume: '成交量',
};

const ACCOUNT_FIELD_LABELS: Record<string, string> = {
  hasPosition: '持仓状态', holdingDays: '持仓天数', unrealizedPnlPercent: '浮动盈亏%',
};

const OPERATOR_OPTIONS: CompareOperator[] = [
  'gt', 'gte', 'lt', 'lte', 'eq', 'crossesAbove', 'crossesBelow', 'between',
];

// ---- Helper: create empty condition ----

let _condCounter = 0;
function newCondition(): ConditionRule {
  _condCounter++;
  return {
    type: 'condition',
    id: `cond_${_condCounter}_${Date.now()}`,
    left: { type: 'market', field: 'close', offset: 0 },
    operator: 'gt',
    right: { type: 'literal', value: 0 },
  };
}

let _grpCounter = 0;
function newGroup(operator: 'all' | 'any' | 'not' = 'all'): RuleGroup {
  _grpCounter++;
  return {
    type: 'group',
    id: `grp_${_grpCounter}_${Date.now()}`,
    operator,
    children: [newCondition()],
  };
}

// ---- Strategy List Drawer ----

function StrategyListDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { strategies, loadList, loadStrategy, createNew, remove } = useStrategyStudioStore();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      loadList().finally(() => setLoading(false));
    }
  }, [open, loadList]);

  return (
    <Drawer
      title="策略列表"
      open={open}
      onClose={onClose}
      width={400}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { createNew(); onClose(); }}>
          新建
        </Button>
      }
    >
      <List
        loading={loading}
        dataSource={strategies}
        locale={{ emptyText: <Empty description="暂无策略，点击新建创建" /> }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Button
                size="small"
                type="link"
                onClick={() => { loadStrategy(item.id); onClose(); }}
              >
                打开
              </Button>,
              <Popconfirm
                title="确定删除？"
                onConfirm={() => remove(item.id)}
              >
                <Button size="small" type="link" danger>删除</Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={item.name}
              description={
                <Space>
                  <Tag color={item.status === 'published' ? 'green' : 'orange'}>
                    {item.status === 'published' ? '已发布' : '草稿'}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(item.updatedAt).toLocaleDateString('zh-CN')}
                  </Text>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Drawer>
  );
}

// ---- Operand Editor ----

function OperandEditor({
  operand,
  onChange,
  doc,
}: {
  operand: Operand;
  onChange: (op: Operand) => void;
  doc: VisualStrategyDocument;
}) {
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      <Select
        size="small"
        value={operand.type}
        style={{ width: '100%' }}
        onChange={(type) => {
          if (type === 'market') onChange({ type: 'market', field: 'close', offset: 0 });
          else if (type === 'indicator') {
            const firstInd = doc.indicators[0];
            onChange({
              type: 'indicator',
              nodeId: firstInd?.id ?? '',
              output: firstInd?.outputs[0]?.key ?? '',
              offset: 0,
            });
          } else if (type === 'account') onChange({ type: 'account', field: 'hasPosition' });
          else if (type === 'parameter') {
            const firstParam = doc.parameters[0];
            onChange({ type: 'parameter', name: firstParam?.name ?? '' });
          } else if (type === 'literal') onChange({ type: 'literal', value: 0 });
        }}
        options={[
          { label: '行情数据', value: 'market' },
          { label: '技术指标', value: 'indicator' },
          { label: '账户状态', value: 'account' },
          { label: '策略参数', value: 'parameter' },
          { label: '固定值', value: 'literal' },
        ]}
      />

      {operand.type === 'market' && (
        <Space size="small">
          <Select
            size="small"
            value={operand.field}
            style={{ width: 100 }}
            onChange={(field) => onChange({ ...operand, field })}
            options={Object.entries(MARKET_FIELD_LABELS).map(([k, v]) => ({ label: v, value: k }))}
          />
          <InputNumber
            size="small"
            value={operand.offset}
            max={0}
            style={{ width: 80 }}
            addonBefore="偏移"
            onChange={(v) => onChange({ ...operand, offset: v ?? 0 })}
          />
        </Space>
      )}

      {operand.type === 'indicator' && (
        <Space size="small">
          <Select
            size="small"
            value={operand.nodeId || undefined}
            style={{ width: 140 }}
            placeholder="选择指标"
            onChange={(nodeId) => {
              const node = doc.indicators.find((n) => n.id === nodeId);
              onChange({ ...operand, nodeId, output: node?.outputs[0]?.key ?? '' });
            }}
            options={doc.indicators.map((ind) => {
              const def = INDICATOR_REGISTRY.find((d) => d.id === ind.indicatorId);
              return { label: def?.name ?? ind.indicatorId, value: ind.id };
            })}
          />
          <Select
            size="small"
            value={operand.output || undefined}
            style={{ width: 100 }}
            placeholder="输出"
            onChange={(output) => onChange({ ...operand, output })}
            options={
              doc.indicators
                .find((n) => n.id === operand.nodeId)
                ?.outputs.map((o) => ({ label: o.label, value: o.key })) ?? []
            }
          />
        </Space>
      )}

      {operand.type === 'account' && (
        <Select
          size="small"
          value={operand.field}
          style={{ width: '100%' }}
          onChange={(field) => onChange({ ...operand, field })}
          options={Object.entries(ACCOUNT_FIELD_LABELS).map(([k, v]) => ({ label: v, value: k }))}
        />
      )}

      {operand.type === 'parameter' && (
        <Select
          size="small"
          value={operand.name || undefined}
          style={{ width: '100%' }}
          placeholder="选择参数"
          onChange={(name) => onChange({ ...operand, name })}
          options={doc.parameters.map((p) => ({ label: p.label, value: p.name }))}
        />
      )}

      {operand.type === 'literal' && (
        <Select
          size="small"
          value={typeof operand.value}
          style={{ width: '100%' }}
          onChange={(t) => onChange({ ...operand, value: t === 'number' ? 0 : false })}
          options={[
            { label: '数字', value: 'number' },
            { label: '布尔值', value: 'boolean' },
          ]}
        />
      )}
      {operand.type === 'literal' && typeof operand.value === 'number' && (
        <InputNumber
          size="small"
          value={operand.value}
          style={{ width: '100%' }}
          onChange={(v) => onChange({ ...operand, value: v ?? 0 })}
        />
      )}
      {operand.type === 'literal' && typeof operand.value === 'boolean' && (
        <Select
          size="small"
          value={operand.value}
          style={{ width: '100%' }}
          onChange={(v) => onChange({ ...operand, value: v })}
          options={[
            { label: 'true', value: true },
            { label: 'false', value: false },
          ]}
        />
      )}
    </Space>
  );
}

// ---- Condition Editor ----

function ConditionEditor({
  condition,
  onChange,
  onDelete,
  doc,
}: {
  condition: ConditionRule;
  onChange: (c: ConditionRule) => void;
  onDelete: () => void;
  doc: VisualStrategyDocument;
}) {
  return (
    <Card
      size="small"
      style={{ marginBottom: 8, background: '#fafafa' }}
      title={
        <Space>
          <Tag color="blue">条件</Tag>
          <Text code style={{ fontSize: 11 }}>{condition.id}</Text>
        </Space>
      }
      extra={
        <Popconfirm title="删除此条件？" onConfirm={onDelete}>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} aria-label="删除条件" />
        </Popconfirm>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Text type="secondary" style={{ fontSize: 12 }}>左操作数</Text>
        <OperandEditor
          operand={condition.left}
          doc={doc}
          onChange={(left) => onChange({ ...condition, left })}
        />

        <Divider style={{ margin: '4px 0' }} />

        <Select
          size="small"
          value={condition.operator}
          style={{ width: '100%' }}
          onChange={(operator) => onChange({ ...condition, operator })}
          options={OPERATOR_OPTIONS.map((op) => ({
            label: `${OPERATOR_LABELS[op]} (${op})`,
            value: op,
          }))}
        />

        {condition.operator === 'between' && (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>下界</Text>
            <OperandEditor
              operand={condition.right}
              doc={doc}
              onChange={(right) => onChange({ ...condition, right })}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>上界</Text>
            <OperandEditor
              operand={condition.upper ?? { type: 'literal', value: 0 }}
              doc={doc}
              onChange={(upper) => onChange({ ...condition, upper })}
            />
          </>
        )}

        {condition.operator !== 'between' && (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>右操作数</Text>
            <OperandEditor
              operand={condition.right}
              doc={doc}
              onChange={(right) => onChange({ ...condition, right })}
            />
          </>
        )}
      </Space>
    </Card>
  );
}

// ---- Rule Group Editor ----

function RuleGroupEditor({
  group,
  onChange,
  doc,
  depth = 0,
}: {
  group: RuleGroup;
  onChange: (g: RuleGroup) => void;
  doc: VisualStrategyDocument;
  depth?: number;
}) {
  const colors = ['blue', 'green', 'orange', 'purple'];
  const color = colors[depth % colors.length];

  const handleChildChange = (index: number, child: ConditionRule | RuleGroup) => {
    const newChildren = [...group.children];
    newChildren[index] = child;
    onChange({ ...group, children: newChildren });
  };

  const handleDeleteChild = (index: number) => {
    const newChildren = group.children.filter((_, i) => i !== index);
    onChange({ ...group, children: newChildren });
  };

  const addCondition = () => {
    onChange({ ...group, children: [...group.children, newCondition()] });
  };

  const addSubGroup = () => {
    onChange({ ...group, children: [...group.children, newGroup()] });
  };

  return (
    <div style={{ marginLeft: depth > 0 ? 16 : 0, marginBottom: 8 }}>
      <Card
        size="small"
        style={{
          borderLeft: `3px solid ${['#1677ff', '#52c41a', '#fa8c16', '#722ed1'][depth % 4]}`,
        }}
        title={
          <Space>
            <Tag color={color}>{group.id}</Tag>
            <Select
              size="small"
              value={group.operator}
              style={{ width: 100 }}
              onChange={(operator) => onChange({ ...group, operator })}
              options={[
                { label: '全部满足 (AND)', value: 'all' },
                { label: '任一满足 (OR)', value: 'any' },
                { label: '取反 (NOT)', value: 'not' },
              ]}
            />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {group.children.length} 个子项
            </Text>
          </Space>
        }
        extra={
          <Space size="small">
            <Tooltip title="添加条件">
              <Button size="small" icon={<PlusOutlined />} onClick={addCondition} aria-label="添加条件" />
            </Tooltip>
            <Tooltip title="添加子组">
              <Button size="small" icon={<CopyOutlined />} onClick={addSubGroup} aria-label="添加子组" />
            </Tooltip>
          </Space>
        }
      >
        {group.children.length === 0 && (
          <Empty description="空规则组，请添加条件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {group.children.map((child, i) => (
          <div key={child.id}>
            {child.type === 'condition' ? (
              <ConditionEditor
                condition={child}
                doc={doc}
                onChange={(c) => handleChildChange(i, c)}
                onDelete={() => handleDeleteChild(i)}
              />
            ) : (
              <RuleGroupEditor
                group={child}
                doc={doc}
                depth={depth + 1}
                onChange={(g) => handleChildChange(i, g)}
              />
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---- Indicator Manager ----

function IndicatorManager({
  indicators,
  onChange,
}: {
  indicators: IndicatorNode[];
  onChange: (inds: IndicatorNode[]) => void;
}) {
  const addIndicator = () => {
    const firstDef = INDICATOR_REGISTRY[0];
    const def = firstDef;
    const newInd: IndicatorNode = {
      id: `ind_${Date.now()}`,
      indicatorId: def.id,
      params: Object.fromEntries(
        def.params.filter((p) => p.defaultValue > 0).map((p) => [p.name, p.defaultValue]),
      ),
      outputs: def.display.series.map((s) => ({ key: s.key, label: s.label, type: 'number' as const })),
    };
    onChange([...indicators, newInd]);
  };

  const updateIndicator = (index: number, ind: IndicatorNode) => {
    const newInds = [...indicators];
    newInds[index] = ind;
    onChange(newInds);
  };

  const removeIndicator = (index: number) => {
    onChange(indicators.filter((_, i) => i !== index));
  };

  return (
    <Card
      size="small"
      title={<Text strong>技术指标</Text>}
      extra={
        <Button size="small" icon={<PlusOutlined />} onClick={addIndicator}>
          添加
        </Button>
      }
    >
      {indicators.length === 0 && (
        <Text type="secondary">暂无指标，点击"添加"引入技术指标</Text>
      )}
      {indicators.map((ind, i) => {
        const def = INDICATOR_REGISTRY.find((d) => d.id === ind.indicatorId);
        return (
          <Card
            key={ind.id}
            size="small"
            style={{ marginBottom: 4 }}
            type="inner"
            title={
              <Space>
                <Tag>{def?.name ?? ind.indicatorId}</Tag>
                <Text code style={{ fontSize: 10 }}>{ind.id}</Text>
              </Space>
            }
            extra={
              <Button
                size="small"
                type="link"
                danger
                onClick={() => removeIndicator(i)}
              >
                删除
              </Button>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size="small">
              <Select
                size="small"
                value={ind.indicatorId}
                style={{ width: '100%' }}
                onChange={(indicatorId) => {
                  const newDef = INDICATOR_REGISTRY.find((d) => d.id === indicatorId);
                  updateIndicator(i, {
                    ...ind,
                    indicatorId,
                    params: Object.fromEntries(
                      (newDef?.params ?? []).filter((p) => p.defaultValue > 0).map((p) => [p.name, p.defaultValue]),
                    ),
                    outputs: (newDef?.display.series ?? []).map((s) => ({
                      key: s.key,
                      label: s.label,
                      type: 'number' as const,
                    })),
                  });
                }}
                options={INDICATOR_REGISTRY.map((d) => ({
                  label: d.name,
                  value: d.id,
                }))}
              />
              {def?.params
                .filter((p) => ind.params[p.name] !== undefined)
                .map((param) => (
                  <Space key={param.name} style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, width: 80 }}>{param.label}</Text>
                    <InputNumber
                      size="small"
                      style={{ flex: 1 }}
                      value={ind.params[param.name]}
                      min={param.min}
                      max={param.max}
                      step={param.step}
                      onChange={(v) => {
                        updateIndicator(i, {
                          ...ind,
                          params: { ...ind.params, [param.name]: v ?? param.defaultValue },
                        });
                      }}
                    />
                  </Space>
                ))}
            </Space>
          </Card>
        );
      })}
    </Card>
  );
}

// ---- Parameter Manager ----

function ParameterManager({
  parameters,
  onChange,
}: {
  parameters: StrategyParameter[];
  onChange: (params: StrategyParameter[]) => void;
}) {
  const addParam = () => {
    const newParam: StrategyParameter = {
      name: `param${parameters.length + 1}`,
      label: `参数${parameters.length + 1}`,
      type: 'number',
      defaultValue: 0,
    };
    onChange([...parameters, newParam]);
  };

  const updateParam = (index: number, param: StrategyParameter) => {
    const newParams = [...parameters];
    newParams[index] = param;
    onChange(newParams);
  };

  const removeParam = (index: number) => {
    onChange(parameters.filter((_, i) => i !== index));
  };

  return (
    <Card
      size="small"
      className="strategy-parameter-card"
      title={<Text strong>策略参数</Text>}
      extra={
        <Button size="small" icon={<PlusOutlined />} onClick={addParam}>
          添加
        </Button>
      }
    >
      {parameters.length === 0 && (
        <Text type="secondary">暂无参数</Text>
      )}
      <div className="strategy-parameter-list">
      {parameters.map((param, i) => (
        <div key={param.name} className="strategy-parameter-row">
          <Input
            size="small"
            className="strategy-parameter-name"
            placeholder="名称"
            aria-label={`参数 ${i + 1} 名称`}
            value={param.name}
            onChange={(e) => updateParam(i, { ...param, name: e.target.value })}
          />
          <Input
            size="small"
            className="strategy-parameter-label"
            placeholder="显示名"
            aria-label={`参数 ${i + 1} 显示名`}
            value={param.label}
            onChange={(e) => updateParam(i, { ...param, label: e.target.value })}
          />
          <Select
            size="small"
            className="strategy-parameter-type"
            value={param.type}
            aria-label={`参数 ${i + 1} 类型`}
            onChange={(type) => updateParam(i, {
              ...param,
              type,
              defaultValue: type === 'boolean' ? false : 0,
            })}
            options={[
              { label: '数字', value: 'number' },
              { label: '布尔', value: 'boolean' },
            ]}
          />
          {param.type === 'number' && (
            <InputNumber
              size="small"
              className="strategy-parameter-value"
              aria-label={`参数 ${i + 1} 默认值`}
              value={param.defaultValue as number}
              onChange={(v) => updateParam(i, { ...param, defaultValue: v ?? 0 })}
            />
          )}
          <Button
            size="small"
            type="link"
            danger
            className="strategy-parameter-delete"
            icon={<DeleteOutlined />}
            aria-label={`删除参数 ${param.label || param.name}`}
            onClick={() => removeParam(i)}
          />
        </div>
      ))}
      </div>
    </Card>
  );
}

// ---- Risk Manager ----

function RiskManager({
  risk,
  onChange,
}: {
  risk: RiskRule[];
  onChange: (risk: RiskRule[]) => void;
}) {
  const types = risk.map((r) => r.type);

  const toggleRule = (type: RiskRule['type']) => {
    if (types.includes(type)) {
      onChange(risk.filter((r) => r.type !== type));
    } else {
      const defaults: Record<string, number> = {
        stopLoss: 8,
        takeProfit: 20,
        maxHoldingDays: 30,
      };
      onChange([...risk, { type, value: defaults[type] }]);
    }
  };

  const updateValue = (type: RiskRule['type'], value: number) => {
    onChange(risk.map((r) => (r.type === type ? { ...r, value } : r)));
  };

  return (
    <Card size="small" title={<Text strong>风控规则</Text>}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Space>
          <Button
            size="small"
            type={types.includes('stopLoss') ? 'primary' : 'default'}
            onClick={() => toggleRule('stopLoss')}
          >
            止损
          </Button>
          <Button
            size="small"
            type={types.includes('takeProfit') ? 'primary' : 'default'}
            onClick={() => toggleRule('takeProfit')}
          >
            止盈
          </Button>
          <Button
            size="small"
            type={types.includes('maxHoldingDays') ? 'primary' : 'default'}
            onClick={() => toggleRule('maxHoldingDays')}
          >
            最大持仓天数
          </Button>
        </Space>

        {risk.map((rule) => (
          <Space key={rule.type} style={{ width: '100%' }}>
            <Text style={{ width: 100 }}>
              {rule.type === 'stopLoss' ? '止损' : rule.type === 'takeProfit' ? '止盈' : '最大持仓'}
            </Text>
            <InputNumber
              size="small"
              style={{ flex: 1 }}
              value={rule.value}
              min={0}
              max={rule.type === 'maxHoldingDays' ? 3650 : 100}
              step={rule.type === 'maxHoldingDays' ? 1 : 0.5}
              addonAfter={rule.type === 'maxHoldingDays' ? '天' : '%'}
              onChange={(v) => updateValue(rule.type, v ?? 0)}
            />
          </Space>
        ))}
      </Space>
    </Card>
  );
}

// ---- Main Page ----

export default function StrategyStudioPage() {
  const {
    document, isDirty, undoStack, redoStack, validationResult,
    createNew, updateDocument, undo, redo, save, publish,
    importDocument, exportDocument,
  } = useStrategyStudioStore();

  const [listOpen, setListOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const candles = useCandleStore((s) => s.candles);
  const preview = useStrategyPreview();

  // Load last draft on mount
  useEffect(() => {
    const load = async () => {
      const strategies = await getRepository().getAllVisualStrategies();
      if (strategies.length > 0) {
        useStrategyStudioStore.getState().loadStrategy(strategies[0].id);
      } else {
        createNew();
      }
    };
    load();
  }, [createNew]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const doc = parseImportedStrategy(reader.result as string);
          const vr = validateDocument(doc);
          if (!vr.valid) {
            message.error(`导入失败: ${vr.errors.map((e) => e.message).join('; ')}`);
            return;
          }
          importDocument(doc);
          message.success('策略已导入');
        } catch {
          message.error('文件格式错误');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    [importDocument],
  );

  const handleExport = useCallback(() => {
    const doc = exportDocument();
    if (!doc) {
      message.warning('没有可导出的策略');
      return;
    }
    downloadStrategyFile(doc);
    message.success('策略已导出');
  }, [exportDocument]);

  // Generate summary
  const summary = document ? explainStrategy(document) : '';

  if (!document) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Empty description="没有加载策略">
          <Button type="primary" onClick={createNew}>创建新策略</Button>
          <Button style={{ marginLeft: 8 }} onClick={() => setListOpen(true)}>打开已有策略</Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <Button style={{ marginLeft: 8 }} onClick={handleImport}>导入策略</Button>
        </Empty>
        <StrategyListDrawer open={listOpen} onClose={() => setListOpen(false)} />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '8px 16px' }}>
      {/* ---- Toolbar ---- */}
      <div style={{ marginBottom: 8 }}>
        <Space wrap>
          <Button icon={<SaveOutlined />} onClick={() => setListOpen(true)}>
            策略列表
          </Button>
          <Input
            style={{ width: 200 }}
            size="small"
            value={document.name}
            onChange={(e) => updateDocument((d) => { d.name = e.target.value; })}
            placeholder="策略名称"
          />
          <TextArea
            style={{ width: 200 }}
            size="small"
            autoSize
            value={document.description}
            onChange={(e) => updateDocument((d) => { d.description = e.target.value; })}
            placeholder="策略说明"
          />

          <Divider type="vertical" />

          <Tooltip title="撤销">
            <Button
              size="small"
              icon={<UndoOutlined />}
              disabled={undoStack.length === 0}
              onClick={undo}
              aria-label="撤销"
            />
          </Tooltip>
          <Tooltip title="重做">
            <Button
              size="small"
              icon={<RedoOutlined />}
              disabled={redoStack.length === 0}
              onClick={redo}
              aria-label="重做"
            />
          </Tooltip>

          <Divider type="vertical" />

          <Badge dot={isDirty}>
            <Button type="primary" icon={<SaveOutlined />} onClick={save}>
              保存草稿
            </Button>
          </Badge>
          <Button icon={<CheckCircleOutlined />} onClick={publish}>
            发布版本
          </Button>

          <Divider type="vertical" />

          <Tooltip title="导入策略 JSON">
            <Button size="small" icon={<ImportOutlined />} onClick={handleImport} aria-label="导入策略 JSON" />
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <Tooltip title="导出策略 JSON">
            <Button size="small" icon={<ExportOutlined />} onClick={handleExport} aria-label="导出策略 JSON" />
          </Tooltip>

          <Tooltip title="AI 生成策略">
            <Button size="small" icon={<BulbOutlined />} onClick={() => setAiDrawerOpen(true)}>
              AI 生成
            </Button>
          </Tooltip>

          <Tooltip title={candles.length === 0 ? '请先加载行情数据' : '预览策略信号'}>
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={candles.length === 0}
              onClick={() => {
                if (!document) return;
                setPreviewOpen(true);
                preview.run(candles, document, {});
              }}
            >
              信号预览
            </Button>
          </Tooltip>

          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            onClick={() => setSummaryOpen(true)}
          >
            策略摘要
          </Button>

          {validationResult && !validationResult.valid && (
            <Tag color="error">
              {validationResult.errors.length} 个错误
            </Tag>
          )}
          {validationResult && validationResult.valid && (
            <Tag color="success">校验通过</Tag>
          )}
        </Space>
      </div>

      {/* ---- Main Content ---- */}
      <Row gutter={12} style={{ flex: 1, overflow: 'hidden' }}>
        {/* Left: Indicators + Parameters + Risk */}
        <Col xs={24} lg={6} style={{ overflow: 'auto', maxHeight: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <IndicatorManager
              indicators={document.indicators}
              onChange={(inds) => updateDocument((d) => { d.indicators = inds; })}
            />
            <ParameterManager
              parameters={document.parameters}
              onChange={(params) => updateDocument((d) => { d.parameters = params; })}
            />
            <RiskManager
              risk={document.risk}
              onChange={(risk) => updateDocument((d) => { d.risk = risk; })}
            />
          </Space>
        </Col>

        {/* Center: Entry + Exit Rule Groups */}
        <Col xs={24} lg={14} style={{ overflow: 'auto', maxHeight: '100%' }}>
          <Collapse
            defaultActiveKey={['entry', 'exit']}
            items={[
              {
                key: 'entry',
                label: (
                  <Space>
                    <Tag color="red">买入条件</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {document.entry.children.length} 个条件组
                    </Text>
                  </Space>
                ),
                children: (
                  <RuleGroupEditor
                    group={document.entry}
                    doc={document}
                    onChange={(entry) => updateDocument((d) => { d.entry = entry; })}
                  />
                ),
              },
              {
                key: 'exit',
                label: (
                  <Space>
                    <Tag color="green">卖出条件</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {document.exit.children.length} 个条件组
                    </Text>
                  </Space>
                ),
                children: (
                  <RuleGroupEditor
                    group={document.exit}
                    doc={document}
                    onChange={(exit) => updateDocument((d) => { d.exit = exit; })}
                  />
                ),
              },
            ]}
          />
        </Col>

        {/* Right: Validation Errors */}
        <Col xs={24} lg={4} style={{ overflow: 'auto', maxHeight: '100%' }}>
          <Card size="small" title="校验结果">
            {!validationResult && <Text type="secondary">未校验</Text>}
            {validationResult && validationResult.valid && (
              <Space direction="vertical">
                <Tag color="success" icon={<CheckCircleOutlined />}>通过</Tag>
                {validationResult.warnings.length > 0 && (
                  <>
                    <Text type="warning" strong>提示:</Text>
                    {validationResult.warnings.map((w, i) => (
                      <Text key={i} type="warning" style={{ fontSize: 12 }}>{w.message}</Text>
                    ))}
                  </>
                )}
              </Space>
            )}
            {validationResult && !validationResult.valid && (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Tag color="error" icon={<CloseCircleOutlined />}>
                  {validationResult.errors.length} 个错误
                </Tag>
                {validationResult.errors.map((e, i) => (
                  <Card key={i} size="small" style={{ width: '100%' }}>
                    <Text style={{ fontSize: 11 }} code>{e.path}</Text>
                    <br />
                    <Text style={{ fontSize: 12 }} type="danger">{e.message}</Text>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      {/* ---- Drawers ---- */}
      <StrategyListDrawer open={listOpen} onClose={() => setListOpen(false)} />

      <Drawer
        title="策略摘要"
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        width={500}
      >
        <pre style={{
          whiteSpace: 'pre-wrap',
          fontSize: 13,
          fontFamily: 'inherit',
          lineHeight: 1.8,
          background: '#f5f5f5',
          padding: 16,
          borderRadius: 6,
        }}>
          {summary}
        </pre>
      </Drawer>

      <GenerateStrategyDrawer
        open={aiDrawerOpen}
        onClose={() => setAiDrawerOpen(false)}
      />

      {/* Signal Preview Drawer */}
      <Drawer
        title="信号预览"
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={700}
      >
        {preview.status === 'running' && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Progress
              percent={preview.progress ? Math.round((preview.progress.current / preview.progress.total) * 100) : 0}
              status="active"
            />
            <Text type="secondary">正在计算信号...</Text>
          </div>
        )}

        {preview.status === 'failed' && (
          <Alert type="error" message="预览失败" description={preview.error} showIcon />
        )}

        {preview.status === 'completed' && (
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Space>
              <Tag color="red">{preview.signals.filter((s) => s.action === 'buy').length} 买入</Tag>
              <Tag color="green">{preview.signals.filter((s) => s.action === 'sell').length} 卖出</Tag>
              <Tag>{preview.signals.filter((s) => s.action === 'hold').length} 持有</Tag>
            </Space>

            <Table
              size="small"
              dataSource={preview.signals.filter((s) => s.action !== 'hold')}
              rowKey={(_, i) => String(i)}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'time',
                  width: 110,
                  render: (t: string) => <Text code style={{ fontSize: 11 }}>{t}</Text>,
                },
                {
                  title: '信号',
                  dataIndex: 'action',
                  width: 60,
                  render: (a: string) => (
                    <Tag color={a === 'buy' ? 'red' : 'green'}>{a === 'buy' ? '买入' : '卖出'}</Tag>
                  ),
                },
                {
                  title: '原因',
                  dataIndex: 'reason',
                  ellipsis: true,
                  render: (r: string) => <Text style={{ fontSize: 12 }}>{r}</Text>,
                },
              ]}
              locale={{ emptyText: '暂无交易信号' }}
            />
          </Space>
        )}
      </Drawer>
    </div>
  );
}

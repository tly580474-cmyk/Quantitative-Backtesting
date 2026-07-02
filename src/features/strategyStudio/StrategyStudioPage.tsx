import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card, Button, Space, Input, Select, InputNumber,
  Typography, Divider, Empty, Tag, Tooltip, Popconfirm,
  message, Drawer, List, Collapse, Badge, Table, Progress, Alert, Dropdown, Modal,
} from 'antd';
import {
  PlusOutlined, SaveOutlined, UndoOutlined, RedoOutlined,
  PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ExportOutlined, ImportOutlined, DeleteOutlined, CopyOutlined,
  EditOutlined, BulbOutlined, ThunderboltOutlined, MoreOutlined,
  ExperimentOutlined,
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

function operandLabel(operand: Operand, doc: VisualStrategyDocument): string {
  switch (operand.type) {
    case 'market':
      return `${MARKET_FIELD_LABELS[operand.field] ?? operand.field}${operand.offset ? `[${operand.offset}]` : ''}`;
    case 'indicator': {
      const indicator = doc.indicators.find((item) => item.id === operand.nodeId);
      const definition = INDICATOR_REGISTRY.find((item) => item.id === indicator?.indicatorId);
      const output = indicator?.outputs.find((item) => item.key === operand.output);
      return `${definition?.name ?? indicator?.indicatorId ?? '未选择指标'} · ${output?.label ?? (operand.output || '输出')}`;
    }
    case 'account':
      return ACCOUNT_FIELD_LABELS[operand.field] ?? operand.field;
    case 'parameter': {
      const parameter = doc.parameters.find((item) => item.name === operand.name);
      return `参数「${parameter?.label ?? (operand.name || '未选择')}」`;
    }
    case 'literal':
      return typeof operand.value === 'boolean'
        ? (operand.value ? '是' : '否')
        : String(operand.value);
  }
}

function findRuleNode(group: RuleGroup, nodeId: string): ConditionRule | RuleGroup | null {
  if (group.id === nodeId) return group;
  for (const child of group.children) {
    if (child.id === nodeId) return child;
    if (child.type === 'group') {
      const nested = findRuleNode(child, nodeId);
      if (nested) return nested;
    }
  }
  return null;
}

function findConditionIdByPath(document: VisualStrategyDocument, path: string): string | null {
  const root = path.startsWith('entry') ? document.entry : path.startsWith('exit') ? document.exit : null;
  if (!root) return null;
  let current: ConditionRule | RuleGroup = root;
  const indexes = [...path.matchAll(/children\[(\d+)\]/g)].map((match) => Number(match[1]));
  for (const index of indexes) {
    if (current.type !== 'group' || !current.children[index]) return current.id;
    current = current.children[index];
  }
  return current.id;
}

function updateConditionInGroup(
  group: RuleGroup,
  nodeId: string,
  condition: ConditionRule,
): RuleGroup {
  return {
    ...group,
    children: group.children.map((child) => {
      if (child.id === nodeId) return condition;
      return child.type === 'group' ? updateConditionInGroup(child, nodeId, condition) : child;
    }),
  };
}

function countConditions(group: RuleGroup): number {
  return group.children.reduce(
    (count, child) => count + (child.type === 'condition' ? 1 : countConditions(child)),
    0,
  );
}

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
  onDelete,
  doc,
  selected,
  onSelect,
}: {
  condition: ConditionRule;
  onDelete: () => void;
  doc: VisualStrategyDocument;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`strategy-condition-row${selected ? ' is-selected' : ''}`}
      data-node-id={condition.id}
      role="button"
      tabIndex={0}
      aria-label={`编辑条件 ${operandLabel(condition.left, doc)} ${OPERATOR_LABELS[condition.operator]} ${operandLabel(condition.right, doc)}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="strategy-condition-kind">条件</span>
      <span className="strategy-condition-operand">{operandLabel(condition.left, doc)}</span>
      <span className="strategy-condition-operator">{OPERATOR_LABELS[condition.operator]}</span>
      <span className="strategy-condition-operand">{operandLabel(condition.right, doc)}</span>
      {condition.operator === 'between' && condition.upper && (
        <>
          <span className="strategy-condition-operator">至</span>
          <span className="strategy-condition-operand">{operandLabel(condition.upper, doc)}</span>
        </>
      )}
      <Tooltip title="在右侧面板编辑">
        <EditOutlined className="strategy-condition-edit" aria-hidden />
      </Tooltip>
      <div onClick={(event) => event.stopPropagation()}>
        <Popconfirm title="删除此条件？" onConfirm={onDelete}>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} aria-label="删除条件" />
        </Popconfirm>
      </div>
    </div>
  );
}

// ---- Rule Group Editor ----

function RuleGroupEditor({
  group,
  onChange,
  doc,
  selectedNodeId,
  onSelectNode,
  depth = 0,
}: {
  group: RuleGroup;
  onChange: (g: RuleGroup) => void;
  doc: VisualStrategyDocument;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
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
    <div
      className={`strategy-rule-group depth-${Math.min(depth, 3)}${selectedNodeId === group.id ? ' is-selected' : ''}`}
      data-node-id={group.id}
    >
      <div className="strategy-rule-group-head" onClick={() => onSelectNode(group.id)}>
        <Space size="small" wrap>
            <Tag color={color}>规则组</Tag>
            <Select
              size="small"
              value={group.operator}
              style={{ width: 136 }}
              onClick={(event) => event.stopPropagation()}
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
        <Space size="small" onClick={(event) => event.stopPropagation()}>
            <Tooltip title="添加条件">
              <Button size="small" icon={<PlusOutlined />} onClick={addCondition} aria-label="添加条件" />
            </Tooltip>
            <Tooltip title="添加子组">
              <Button size="small" icon={<CopyOutlined />} onClick={addSubGroup} aria-label="添加子组" />
            </Tooltip>
        </Space>
      </div>
      <div className="strategy-rule-group-body">
        {group.children.length === 0 && (
          <Empty description="空规则组，请添加条件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {group.children.map((child, i) => (
          <div key={child.id}>
            {child.type === 'condition' ? (
              <ConditionEditor
                condition={child}
                doc={doc}
                onDelete={() => handleDeleteChild(i)}
                selected={selectedNodeId === child.id}
                onSelect={() => onSelectNode(child.id)}
              />
            ) : (
              <RuleGroupEditor
                group={child}
                doc={doc}
                depth={depth + 1}
                onChange={(g) => handleChildChange(i, g)}
                selectedNodeId={selectedNodeId}
                onSelectNode={onSelectNode}
              />
            )}
          </div>
        ))}
      </div>
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
        trailingStop: 10,
        maxHoldingDays: 30,
      };
      onChange([
        ...risk,
        type === 'lossStreakCooldown'
          ? { type, losses: 2, months: 12 }
          : { type, value: defaults[type] },
      ]);
    }
  };

  const updateValue = (type: RiskRule['type'], value: number) => {
    onChange(risk.map((r) => (
      r.type === type && r.type !== 'lossStreakCooldown' ? { ...r, value } : r
    )));
  };

  const updateCooldown = (field: 'losses' | 'months', value: number) => {
    onChange(risk.map((rule) => (
      rule.type === 'lossStreakCooldown' ? { ...rule, [field]: value } : rule
    )));
  };

  return (
    <Card size="small" title={<Text strong>风控规则</Text>}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Space wrap>
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
          <Tooltip title="当前价相对买入后持仓期最高价回撤达到阈值时卖出">
            <Button
              size="small"
              type={types.includes('trailingStop') ? 'primary' : 'default'}
              onClick={() => toggleRule('trailingStop')}
            >
              移动止盈
            </Button>
          </Tooltip>
          <Button
            size="small"
            type={types.includes('maxHoldingDays') ? 'primary' : 'default'}
            onClick={() => toggleRule('maxHoldingDays')}
          >
            最大持仓天数
          </Button>
          <Tooltip title="连续若干笔完整交易亏损后，暂停新的买入一段时间">
            <Button
              size="small"
              type={types.includes('lossStreakCooldown') ? 'primary' : 'default'}
              onClick={() => toggleRule('lossStreakCooldown')}
            >
              连亏暂停
            </Button>
          </Tooltip>
        </Space>

        {risk.map((rule) => rule.type === 'lossStreakCooldown' ? (
          <Space key={rule.type} style={{ width: '100%' }} wrap>
            <Text style={{ width: 100 }}>连续亏损暂停</Text>
            <Text type="secondary">连续</Text>
            <InputNumber
              aria-label="连续亏损笔数"
              size="small"
              value={rule.losses}
              min={1}
              max={100}
              step={1}
              addonAfter="笔"
              onChange={(v) => updateCooldown('losses', v ?? 1)}
            />
            <Text type="secondary">暂停</Text>
            <InputNumber
              aria-label="暂停交易月数"
              size="small"
              value={rule.months}
              min={1}
              max={120}
              step={1}
              addonAfter="个月"
              onChange={(v) => updateCooldown('months', v ?? 1)}
            />
          </Space>
        ) : (
          <Space key={rule.type} style={{ width: '100%' }}>
            <Text style={{ width: 100 }}>
              {rule.type === 'stopLoss'
                ? '止损'
                : rule.type === 'takeProfit'
                  ? '止盈'
                  : rule.type === 'trailingStop'
                    ? '最高价回撤'
                    : '最大持仓'}
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

function StrategyInspector({
  document,
  selectedNodeId,
  validationResult,
  previewStatus,
  previewSignals,
  onConditionChange,
  onSelectError,
}: {
  document: VisualStrategyDocument;
  selectedNodeId: string | null;
  validationResult: ReturnType<typeof validateDocument> | null;
  previewStatus: ReturnType<typeof useStrategyPreview>['status'];
  previewSignals: ReturnType<typeof useStrategyPreview>['signals'];
  onConditionChange: (condition: ConditionRule) => void;
  onSelectError: (path: string) => void;
}) {
  const selectedNode = selectedNodeId
    ? findRuleNode(document.entry, selectedNodeId) ?? findRuleNode(document.exit, selectedNodeId)
    : null;
  const buySignals = previewSignals.filter((signal) => signal.action === 'buy');
  const sellSignals = previewSignals.filter((signal) => signal.action === 'sell');
  const actionableSignals = previewSignals.filter((signal) => signal.action !== 'hold');

  return (
    <div className="strategy-inspector-stack">
      <Card
        size="small"
        className="strategy-inspector-card"
        title="属性"
        extra={selectedNode && <Tag color="blue">{selectedNode.type === 'condition' ? '条件' : '规则组'}</Tag>}
      >
        {!selectedNode && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="选择画布中的条件进行编辑"
          />
        )}
        {selectedNode?.type === 'group' && (
          <Space direction="vertical" size="small">
            <Text strong>{selectedNode.id}</Text>
            <Text type="secondary">
              {selectedNode.operator === 'all' ? '所有子项同时满足' : selectedNode.operator === 'any' ? '任一子项满足' : '对子项结果取反'}
            </Text>
            <Tag>{selectedNode.children.length} 个子项</Tag>
          </Space>
        )}
        {selectedNode?.type === 'condition' && (
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Text type="secondary">左操作数</Text>
            <OperandEditor
              operand={selectedNode.left}
              doc={document}
              onChange={(left) => onConditionChange({ ...selectedNode, left })}
            />
            <Text type="secondary">比较关系</Text>
            <Select
              size="small"
              value={selectedNode.operator}
              style={{ width: '100%' }}
              onChange={(operator) => onConditionChange({
                ...selectedNode,
                operator,
                upper: operator === 'between'
                  ? selectedNode.upper ?? { type: 'literal', value: 0 }
                  : undefined,
              })}
              options={OPERATOR_OPTIONS.map((operator) => ({
                label: `${OPERATOR_LABELS[operator]} (${operator})`,
                value: operator,
              }))}
            />
            <Text type="secondary">{selectedNode.operator === 'between' ? '下界' : '右操作数'}</Text>
            <OperandEditor
              operand={selectedNode.right}
              doc={document}
              onChange={(right) => onConditionChange({ ...selectedNode, right })}
            />
            {selectedNode.operator === 'between' && (
              <>
                <Text type="secondary">上界</Text>
                <OperandEditor
                  operand={selectedNode.upper ?? { type: 'literal', value: 0 }}
                  doc={document}
                  onChange={(upper) => onConditionChange({ ...selectedNode, upper })}
                />
              </>
            )}
          </Space>
        )}
      </Card>

      <Card size="small" className="strategy-inspector-card" title="校验与反馈">
        {validationResult?.valid ? (
          <Alert
            type={validationResult.warnings.length ? 'warning' : 'success'}
            showIcon
            title={validationResult.warnings.length ? `${validationResult.warnings.length} 条提示` : '策略校验通过'}
          />
        ) : (
          <Alert
            type="error"
            showIcon
            title={`${validationResult?.errors.length ?? 0} 个错误`}
            description="点击问题可定位到对应规则。"
          />
        )}

        {!!validationResult?.errors.length && (
          <div className="strategy-issue-list">
            {validationResult.errors.map((error, index) => (
              <button
                key={`${error.path}-${index}`}
                type="button"
                className="strategy-issue is-error"
                onClick={() => onSelectError(error.path)}
              >
                <code>{error.path}</code>
                <span>{error.message}</span>
              </button>
            ))}
          </div>
        )}
        {!!validationResult?.warnings.length && (
          <div className="strategy-issue-list">
            {validationResult.warnings.map((warning, index) => (
              <button
                key={`${warning.path}-${index}`}
                type="button"
                className="strategy-issue is-warning"
                onClick={() => onSelectError(warning.path)}
              >
                <code>{warning.path}</code>
                <span>{warning.message}</span>
              </button>
            ))}
          </div>
        )}

        <Divider style={{ margin: '12px 0' }} />
        <div className="strategy-signal-summary">
          <div>
            <span>买入</span>
            <strong>{previewStatus === 'completed' ? buySignals.length : '—'}</strong>
          </div>
          <div>
            <span>卖出</span>
            <strong>{previewStatus === 'completed' ? sellSignals.length : '—'}</strong>
          </div>
          <div>
            <span>最近信号</span>
            <strong>
              {previewStatus === 'completed'
                ? actionableSignals[actionableSignals.length - 1]?.time?.slice(0, 10) ?? '无'
                : '待预览'}
            </strong>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---- Main Page ----

export default function StrategyStudioPage() {
  const {
    document, isDirty, undoStack, redoStack, validationResult, selectedNodeId,
    createNew, updateDocument, undo, redo, save, publish,
    importDocument, exportDocument, selectNode,
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

  const handleCreateNew = useCallback(() => {
    createNew();
    message.success('已新建空白策略');
  }, [createNew]);

  const handleNewRequest = useCallback(() => {
    if (!isDirty) {
      handleCreateNew();
      return;
    }
    Modal.confirm({
      title: '新建策略？',
      content: '当前策略尚未保存，新建后未保存内容将丢失。',
      okText: '仍要新建',
      cancelText: '取消',
      onOk: handleCreateNew,
    });
  }, [handleCreateNew, isDirty]);

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

  const handleConditionChange = useCallback((condition: ConditionRule) => {
    if (!selectedNodeId) return;
    updateDocument((draft) => {
      draft.entry = updateConditionInGroup(draft.entry, selectedNodeId, condition);
      draft.exit = updateConditionInGroup(draft.exit, selectedNodeId, condition);
    });
  }, [selectedNodeId, updateDocument]);

  const handleIssueSelect = useCallback((path: string) => {
    if (!document) return;
    const nodeId = findConditionIdByPath(document, path);
    if (!nodeId) {
      message.info('该问题位于策略全局配置中');
      return;
    }
    selectNode(nodeId);
    requestAnimationFrame(() => {
      const element = window.document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [document, selectNode]);

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
    <div className="strategy-studio">
      <header className="strategy-studio-header">
        <div className="strategy-studio-identity">
          <Input
            className="strategy-studio-name"
            value={document.name}
            onChange={(event) => updateDocument((draft) => { draft.name = event.target.value; })}
            placeholder="策略名称"
            aria-label="策略名称"
          />
          <TextArea
            className="strategy-studio-description"
            autoSize={{ minRows: 1, maxRows: 2 }}
            value={document.description}
            onChange={(event) => updateDocument((draft) => { draft.description = event.target.value; })}
            placeholder="补充策略说明，让逻辑和适用场景更清楚"
            aria-label="策略说明"
          />
          <Space size="small" wrap>
            <Tag color={isDirty ? 'orange' : 'default'}>{isDirty ? '有未保存修改' : '已保存'}</Tag>
            <Tag>版本 {document.strategyVersion}</Tag>
            {validationResult?.valid ? (
              <Tag color="success" icon={<CheckCircleOutlined />}>校验通过</Tag>
            ) : (
              <Tag color="error" icon={<CloseCircleOutlined />}>
                {validationResult?.errors.length ?? 0} 个错误
              </Tag>
            )}
          </Space>
        </div>

        <div className="strategy-studio-actions">
          <Space.Compact>
            <Tooltip title="撤销">
              <Button
                icon={<UndoOutlined />}
                disabled={undoStack.length === 0}
                onClick={undo}
                aria-label="撤销"
              />
            </Tooltip>
            <Tooltip title="重做">
              <Button
                icon={<RedoOutlined />}
                disabled={redoStack.length === 0}
                onClick={redo}
                aria-label="重做"
              />
            </Tooltip>
          </Space.Compact>
          <Badge dot={isDirty}>
            <Button type="primary" icon={<SaveOutlined />} onClick={() => void save()}>
              保存
            </Button>
          </Badge>
          <Tooltip title={candles.length === 0 ? '请先在行情分析中加载数据' : '计算当前数据上的买卖信号'}>
            <Button
              icon={<PlayCircleOutlined />}
              disabled={candles.length === 0}
              loading={preview.status === 'running'}
              onClick={() => {
                setPreviewOpen(true);
                preview.run(candles, document, {});
              }}
            >
              信号预览
            </Button>
          </Tooltip>
          <Button
            icon={<CheckCircleOutlined />}
            disabled={!validationResult?.valid}
            onClick={() => {
              void publish()
                .then(() => message.success('策略版本已发布'))
                .catch((error: unknown) => message.error(error instanceof Error ? error.message : '发布失败'));
            }}
          >
            发布
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'list', icon: <SaveOutlined />, label: '策略列表', onClick: () => setListOpen(true) },
                { key: 'new', icon: <PlusOutlined />, label: '新建策略', onClick: handleNewRequest },
                { type: 'divider' },
                { key: 'ai', icon: <BulbOutlined />, label: 'AI 生成策略', onClick: () => setAiDrawerOpen(true) },
                { key: 'summary', icon: <ThunderboltOutlined />, label: '查看策略摘要', onClick: () => setSummaryOpen(true) },
                { type: 'divider' },
                { key: 'import', icon: <ImportOutlined />, label: '导入 JSON', onClick: handleImport },
                { key: 'export', icon: <ExportOutlined />, label: '导出 JSON', onClick: handleExport },
              ],
            }}
          >
            <Button icon={<MoreOutlined />} aria-label="更多策略操作">更多</Button>
          </Dropdown>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </header>

      <div className="strategy-studio-workspace">
        <aside className="strategy-studio-library" aria-label="策略构建素材">
          <div className="strategy-panel-heading">
            <span>构建素材</span>
            <Text type="secondary">指标、参数与风控</Text>
          </div>
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
        </aside>

        <main className="strategy-studio-canvas">
          <div className="strategy-panel-heading">
            <Space size="small">
              <ExperimentOutlined />
              <span>策略规则</span>
            </Space>
            <Text type="secondary">
              {countConditions(document.entry) + countConditions(document.exit)} 个条件
            </Text>
          </div>
          <Collapse
            className="strategy-rule-sections"
            defaultActiveKey={['entry', 'exit']}
            items={[
              {
                key: 'entry',
                label: (
                  <Space>
                    <Tag color="red">买入条件</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {countConditions(document.entry)} 个条件
                    </Text>
                  </Space>
                ),
                children: (
                  <RuleGroupEditor
                    group={document.entry}
                    doc={document}
                    onChange={(entry) => updateDocument((d) => { d.entry = entry; })}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={selectNode}
                  />
                ),
              },
              {
                key: 'exit',
                label: (
                  <Space>
                    <Tag color="green">卖出条件</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {countConditions(document.exit)} 个条件
                    </Text>
                  </Space>
                ),
                children: (
                  <RuleGroupEditor
                    group={document.exit}
                    doc={document}
                    onChange={(exit) => updateDocument((d) => { d.exit = exit; })}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={selectNode}
                  />
                ),
              },
            ]}
          />
        </main>

        <aside className="strategy-studio-inspector" aria-label="属性与校验面板">
          <div className="strategy-panel-heading">
            <span>属性与反馈</span>
            <Text type="secondary">选择规则后编辑</Text>
          </div>
          <StrategyInspector
            document={document}
            selectedNodeId={selectedNodeId}
            validationResult={validationResult}
            previewStatus={preview.status}
            previewSignals={preview.signals}
            onConditionChange={handleConditionChange}
            onSelectError={handleIssueSelect}
          />
        </aside>
      </div>

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
          <Alert type="error" title="预览失败" description={preview.error} showIcon />
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

import type {
  StrategyConfirmationDraft,
  StrategyConfirmationField,
  StrategyDocument,
} from './provider.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collectConditions(value: unknown): Record<string, unknown>[] {
  const node = record(value);
  if (!node) return [];
  if (node.type === 'condition') return [node];
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap(collectConditions);
}

function conditionSummary(value: unknown): string {
  const conditions = collectConditions(value);
  if (conditions.length === 0) return '未提取到可执行条件';
  const operators = [...new Set(conditions.map((condition) => String(condition.operator)))];
  return `${conditions.length} 条条件（${operators.join('、')}）`;
}

function riskSummary(strategy: StrategyDocument): string {
  if (!Array.isArray(strategy.risk) || strategy.risk.length === 0) return '未配置';
  return strategy.risk.map((value: unknown) => {
    const rule = record(value);
    if (!rule) return '未知规则';
    if (rule.type === 'lossStreakCooldown') {
      return `${String(rule.type)}(${String(rule.losses)}/${String(rule.months)})`;
    }
    return `${String(rule.type)}(${String(rule.value)})`;
  }).join('、');
}

function indicatorSummary(strategy: StrategyDocument): string {
  if (!Array.isArray(strategy.indicators) || strategy.indicators.length === 0) return '无';
  return strategy.indicators.map((value: unknown) => {
    const indicator = record(value);
    return String(indicator?.indicatorId ?? 'unknown');
  }).join('、');
}

function fields(strategy: StrategyDocument): StrategyConfirmationField[] {
  return [
    {
      key: 'strategyName',
      label: '策略名称',
      value: String(strategy.name ?? ''),
      evidencePath: 'name',
    },
    {
      key: 'indicators',
      label: '指标与因子',
      value: indicatorSummary(strategy),
      evidencePath: 'indicators',
    },
    {
      key: 'entry',
      label: '买入条件',
      value: conditionSummary(strategy.entry),
      evidencePath: 'entry',
    },
    {
      key: 'exit',
      label: '卖出条件',
      value: conditionSummary(strategy.exit),
      evidencePath: 'exit',
    },
    {
      key: 'risk',
      label: '风控规则',
      value: riskSummary(strategy),
      evidencePath: 'risk',
    },
  ];
}

/**
 * Builds a deterministic confirmation view from an already validated DSL.
 * Assumptions are never merged into executable rules.
 */
export function buildStrategyConfirmationDraft(
  sourceText: string,
  strategy: StrategyDocument,
): StrategyConfirmationDraft {
  return {
    sourceText,
    extractedFields: fields(strategy),
    assumptions: [
      {
        id: 'universe',
        label: '交易标的',
        selectedValue: '当前回测界面选择的单一标的',
        options: ['当前回测界面选择的单一标的'],
        reason: 'Strategy DSL v1.0 不保存股票代码或动态股票池。',
        required: true,
      },
      {
        id: 'frequency',
        label: '信号频率',
        selectedValue: '日线',
        options: ['日线'],
        reason: '当前权威回测路径只支持日线信号。',
        required: true,
      },
      {
        id: 'execution',
        label: '成交时点',
        selectedValue: '信号后下一交易时点成交（A 股 T+1）',
        options: ['信号后下一交易时点成交（A 股 T+1）'],
        reason: '避免使用当日收盘信号在同一收盘价成交。',
        required: true,
      },
      {
        id: 'costs',
        label: '交易成本',
        selectedValue: '沿用回测面板中的佣金、印花税和滑点',
        options: ['沿用回测面板中的佣金、印花税和滑点'],
        reason: '交易成本属于运行配置，不写入策略 DSL。',
        required: true,
      },
      {
        id: 'dateRange',
        label: '回测区间',
        selectedValue: '沿用回测面板当前数据区间',
        options: ['沿用回测面板当前数据区间'],
        reason: '日期区间属于实验配置，不由模型推测。',
        required: true,
      },
    ],
  };
}

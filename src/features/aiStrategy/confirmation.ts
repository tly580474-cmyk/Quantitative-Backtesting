import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import type {
  StrategyConfirmationDraft,
  StrategyConfirmationField,
} from './types';

function countConditions(rule: VisualStrategyDocument['entry']): {
  count: number;
  operators: string[];
} {
  const operators: string[] = [];
  let count = 0;
  const visit = (node: VisualStrategyDocument['entry']['children'][number]) => {
    if (node.type === 'condition') {
      count += 1;
      operators.push(node.operator);
      return;
    }
    node.children.forEach(visit);
  };
  rule.children.forEach(visit);
  return { count, operators: [...new Set(operators)] };
}

function ruleSummary(rule: VisualStrategyDocument['entry']): string {
  const result = countConditions(rule);
  return result.count === 0
    ? '未提取到可执行条件'
    : `${result.count} 条条件（${result.operators.join('、')}）`;
}

function extractedFields(strategy: VisualStrategyDocument): StrategyConfirmationField[] {
  return [
    { key: 'strategyName', label: '策略名称', value: strategy.name, evidencePath: 'name' },
    {
      key: 'indicators',
      label: '指标与因子',
      value: strategy.indicators.map((item) => item.indicatorId).join('、') || '无',
      evidencePath: 'indicators',
    },
    { key: 'entry', label: '买入条件', value: ruleSummary(strategy.entry), evidencePath: 'entry' },
    { key: 'exit', label: '卖出条件', value: ruleSummary(strategy.exit), evidencePath: 'exit' },
    {
      key: 'risk',
      label: '风控规则',
      value: strategy.risk.map((rule) => (
        rule.type === 'lossStreakCooldown'
          ? `${rule.type}(${rule.losses}/${rule.months})`
          : `${rule.type}(${rule.value})`
      )).join('、') || '未配置',
      evidencePath: 'risk',
    },
  ];
}

/** Local Mock fallback. The server produces the same deterministic contract. */
export function buildLocalConfirmationDraft(
  sourceText: string,
  strategy: VisualStrategyDocument,
): StrategyConfirmationDraft {
  return {
    sourceText,
    extractedFields: extractedFields(strategy),
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

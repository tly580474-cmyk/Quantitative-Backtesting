import type {
  VisualStrategyDocument,
  ConditionRule,
  RuleGroup,
  Operand,
  IndicatorNode,
} from './types';
import { INDICATOR_REGISTRY } from '@/features/indicators/registry';

/**
 * Generate a Chinese natural-language summary of a strategy DSL document.
 */
export function explainStrategy(doc: VisualStrategyDocument): string {
  const parts: string[] = [];

  parts.push(`策略名称: ${doc.name}`);
  if (doc.description) {
    parts.push(`说明: ${doc.description}`);
  }

  // Indicators
  if (doc.indicators.length > 0) {
    parts.push(`使用指标: ${doc.indicators.map(describeIndicator).join('、')}`);
  }

  // Parameters
  if (doc.parameters.length > 0) {
    parts.push(
      `可调参数: ${doc.parameters
        .map((p) => `${p.label}（${p.name}=${p.defaultValue}）`)
        .join('、')}`,
    );
  }

  // Entry rules
  parts.push('');
  parts.push(`买入条件: ${describeGroup(doc.entry, doc)}`);

  // Exit rules
  parts.push(`卖出条件: ${describeGroup(doc.exit, doc)}`);

  // Risk rules
  if (doc.risk.length > 0) {
    const riskDescs = doc.risk.map(describeRisk);
    parts.push(`风控规则: ${riskDescs.join('；')}`);
  }

  return parts.join('\n');
}

function describeIndicator(node: IndicatorNode): string {
  const def = INDICATOR_REGISTRY.find((d) => d.id === node.indicatorId);
  const name = def?.name ?? node.indicatorId;
  const params = Object.entries(node.params)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (params) {
    return `${name}(${params})`;
  }
  return name;
}

function describeGroup(group: RuleGroup, doc: VisualStrategyDocument): string {
  if (group.children.length === 0) {
    return '（空）';
  }

  const childDescs = group.children
    .map((child) => {
      if (child.type === 'condition') {
        return describeCondition(child, doc);
      }
      return `(${describeGroup(child, doc)})`;
    })
    .filter(Boolean);

  if (childDescs.length === 0) return '（空）';

  switch (group.operator) {
    case 'all':
      return childDescs.join(' 且 ');
    case 'any':
      return childDescs.join(' 或 ');
    case 'not':
      return `非（${childDescs.join(' 且 ')}）`;
  }
}

function describeCondition(cond: ConditionRule, doc: VisualStrategyDocument): string {
  const left = describeOperand(cond.left, doc);
  const right = describeOperand(cond.right, doc);

  if (!left || !right) return '';

  switch (cond.operator) {
    case 'gt':
      return `${left} 大于 ${right}`;
    case 'gte':
      return `${left} 大于等于 ${right}`;
    case 'lt':
      return `${left} 小于 ${right}`;
    case 'lte':
      return `${left} 小于等于 ${right}`;
    case 'eq':
      return `${left} 等于 ${right}`;
    case 'crossesAbove':
      return `${left} 上穿 ${right}`;
    case 'crossesBelow':
      return `${left} 下穿 ${right}`;
    case 'between': {
      const upper = cond.upper ? describeOperand(cond.upper, doc) : '?';
      return `${left} 介于 ${right} 与 ${upper} 之间`;
    }
  }
}

function describeOperand(op: Operand, doc: VisualStrategyDocument): string {
  switch (op.type) {
    case 'market': {
      const fieldNames: Record<string, string> = {
        open: '开盘价',
        high: '最高价',
        low: '最低价',
        close: '收盘价',
        volume: '成交量',
      };
      const name = fieldNames[op.field] ?? op.field;
      if (op.offset < 0) {
        return `${Math.abs(op.offset)} 根前的${name}`;
      }
      return name;
    }
    case 'indicator': {
      const node = doc.indicators.find((n) => n.id === op.nodeId);
      const indicatorName = node
        ? INDICATOR_REGISTRY.find((d) => d.id === node.indicatorId)?.name ?? node.indicatorId
        : op.nodeId;
      const outputLabel = node?.outputs.find((o) => o.key === op.output)?.label ?? op.output;
      const offset = op.offset < 0 ? `${Math.abs(op.offset)} 根前的` : '';
      return `${offset}${indicatorName} ${outputLabel}`;
    }
    case 'account': {
      const fieldNames: Record<string, string> = {
        hasPosition: '是否有持仓',
        holdingDays: '持仓天数',
        unrealizedPnlPercent: '浮动盈亏百分比',
      };
      return fieldNames[op.field] ?? op.field;
    }
    case 'parameter': {
      const param = doc.parameters.find((p) => p.name === op.name);
      return param?.label ?? op.name;
    }
    case 'literal': {
      return String(op.value);
    }
  }
}

function describeRisk(rule: import('./types').RiskRule): string {
  switch (rule.type) {
    case 'stopLoss':
      return `止损 ${rule.value}%`;
    case 'takeProfit':
      return `止盈 ${rule.value}%`;
    case 'maxHoldingDays':
      return `最大持仓 ${rule.value} 天`;
  }
}

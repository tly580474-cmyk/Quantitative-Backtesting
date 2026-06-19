import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import type { GenerateStrategyResult, StrategyExplanation } from './types';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Browser-side mock that returns plausible strategy DSL without a server.
 * Mirrors the server's MockStrategyGenerationProvider.
 */
export async function localGenerate(prompt: string): Promise<GenerateStrategyResult> {
  await delay(600);

  const lower = prompt.toLowerCase();
  const hasMa = lower.includes('均线') || lower.includes('ma') || lower.includes('sma');
  const hasRsi = lower.includes('rsi');
  const hasMacd = lower.includes('macd');
  const hasBoll = lower.includes('布林') || lower.includes('boll');
  const hasStopLoss = lower.includes('止损');
  const hasTakeProfit = lower.includes('止盈');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const indicators: Record<string, unknown>[] = [];
  const entryChildren: unknown[] = [];
  const exitChildren: unknown[] = [];
  const risk: unknown[] = [];

  if (hasMa) {
    indicators.push({
      id: 'sma1',
      indicatorId: 'sma',
      params: { period1: 5, period2: 20 },
      outputs: [
        { key: 'sma1', label: 'SMA5', type: 'number' },
        { key: 'sma2', label: 'SMA20', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'golden_cross',
      left: { type: 'indicator', nodeId: 'sma1', output: 'sma1', offset: 0 },
      operator: 'crossesAbove',
      right: { type: 'indicator', nodeId: 'sma1', output: 'sma2', offset: 0 },
    });
    exitChildren.push({
      type: 'condition', id: 'dead_cross',
      left: { type: 'indicator', nodeId: 'sma1', output: 'sma1', offset: 0 },
      operator: 'crossesBelow',
      right: { type: 'indicator', nodeId: 'sma1', output: 'sma2', offset: 0 },
    });
  }

  if (hasRsi) {
    indicators.push({
      id: 'rsi1', indicatorId: 'rsi', params: { period: 14 },
      outputs: [{ key: 'rsi', label: 'RSI14', type: 'number' }],
    });
    if (entryChildren.length > 0) {
      entryChildren.unshift({
        type: 'condition', id: 'rsi_filter',
        left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi', offset: 0 },
        operator: 'lt', right: { type: 'literal', value: 70 },
      });
    } else {
      entryChildren.push({
        type: 'condition', id: 'rsi_oversold',
        left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi', offset: 0 },
        operator: 'lt', right: { type: 'literal', value: 30 },
      });
    }
  }

  if (hasMacd && !hasMa) {
    indicators.push({
      id: 'macd1', indicatorId: 'macd', params: { fast: 12, slow: 26, signal: 9 },
      outputs: [
        { key: 'dif', label: 'DIF', type: 'number' },
        { key: 'dea', label: 'DEA', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'macd_golden',
      left: { type: 'indicator', nodeId: 'macd1', output: 'dif', offset: 0 },
      operator: 'crossesAbove',
      right: { type: 'indicator', nodeId: 'macd1', output: 'dea', offset: 0 },
    });
  }

  if (hasBoll && !hasMa) {
    indicators.push({
      id: 'boll1', indicatorId: 'boll', params: { period: 20, stdDev: 2 },
      outputs: [
        { key: 'upper', label: '上轨', type: 'number' },
        { key: 'middle', label: '中轨', type: 'number' },
        { key: 'lower', label: '下轨', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'boll_lower',
      left: { type: 'market', field: 'close', offset: 0 },
      operator: 'crossesAbove',
      right: { type: 'indicator', nodeId: 'boll1', output: 'lower', offset: 0 },
    });
  }

  if (hasStopLoss) risk.push({ type: 'stopLoss', value: 8 });
  if (hasTakeProfit) risk.push({ type: 'takeProfit', value: 20 });

  if (entryChildren.length === 0) {
    indicators.push({
      id: 'sma_default', indicatorId: 'sma', params: { period1: 10 },
      outputs: [{ key: 'sma1', label: 'SMA10', type: 'number' }],
    });
    entryChildren.push({
      type: 'condition', id: 'above_sma',
      left: { type: 'market', field: 'close', offset: 0 },
      operator: 'gt',
      right: { type: 'indicator', nodeId: 'sma_default', output: 'sma1', offset: 0 },
    });
    exitChildren.push({
      type: 'condition', id: 'below_sma',
      left: { type: 'market', field: 'close', offset: 0 },
      operator: 'lt',
      right: { type: 'indicator', nodeId: 'sma_default', output: 'sma1', offset: 0 },
    });
  }

  const strategy: VisualStrategyDocument = {
    schemaVersion: '1.0', id, name: generateName(lower),
    description: `AI 基于 "${prompt}" 生成的策略`,
    strategyVersion: 1, parameters: [], indicators: indicators as unknown as VisualStrategyDocument['indicators'],
    entry: { type: 'group', id: 'entry_root', operator: 'all', children: entryChildren as unknown as VisualStrategyDocument['entry']['children'] },
    exit: { type: 'group', id: 'exit_root', operator: 'any', children: (exitChildren.length > 0 ? exitChildren : [{ type: 'condition', id: 'empty', left: { type: 'literal', value: false }, operator: 'eq' as const, right: { type: 'literal', value: true } }]) as unknown as VisualStrategyDocument['exit']['children'] },
    risk: risk as unknown as VisualStrategyDocument['risk'],
    metadata: { source: 'ai', createdAt: now, updatedAt: now, aiGenerationId: id },
  } as VisualStrategyDocument;

  return {
    generationId: id, strategy,
    summary: `基于 "${prompt}" 生成的策略，含 ${indicators.length} 个指标和 ${risk.length} 个风控规则。`,
    warnings: ['AI 生成策略仅供参考，请在信号预览中验证。', '请确认技术指标参数是否符合预期。'],
    requiresConfirmation: true,
  };
}

export function localExplain(strategy: VisualStrategyDocument): StrategyExplanation {
  const indNames = (strategy.indicators || []).map((i) => i.indicatorId).join('、');
  const riskCount = (strategy.risk || []).length;
  return {
    explanation: `该策略使用: ${indNames || '无'}。包含 ${riskCount} 个风控规则。`,
    risks: ['技术指标存在滞后性。', '过拟合风险。'],
    parameterNotes: '建议对关键参数进行鲁棒性测试。',
  };
}

function generateName(prompt: string): string {
  if (prompt.includes('均线')) return '均线交叉策略';
  if (prompt.includes('rsi')) return 'RSI 策略';
  if (prompt.includes('macd')) return 'MACD 策略';
  if (prompt.includes('布林')) return '布林带策略';
  return 'AI 生成策略';
}

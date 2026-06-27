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
  const hasBias = lower.includes('bias') || lower.includes('乖离');
  const hasVolatility = lower.includes('波动率') || lower.includes('volatility');
  const hasVolCluster = lower.includes('波动聚集') || lower.includes('volcluster');
  const hasHold = lower.includes('hold') || lower.includes('买入持有') || lower.includes('持有收益');
  const hasReversal = lower.includes('反转') || lower.includes('reversal');
  const hasVolume = lower.includes('成交量') || lower.includes('放量') || lower.includes('缩量') || lower.includes('volume');
  const hasBreakout = lower.includes('突破') || lower.includes('新高') || lower.includes('新低') || lower.includes('breakout');
  const hasDrawdown = lower.includes('回撤') || lower.includes('drawdown');
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
      id: 'rsi1', indicatorId: 'rsi', params: { period1: 6, period2: 12, period3: 24 },
      outputs: [
        { key: 'rsi1', label: 'RSI1', type: 'number' },
        { key: 'rsi2', label: 'RSI2', type: 'number' },
        { key: 'rsi3', label: 'RSI3', type: 'number' },
      ],
    });
    if (entryChildren.length > 0) {
      entryChildren.unshift({
        type: 'condition', id: 'rsi_filter',
        left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi1', offset: 0 },
        operator: 'lt', right: { type: 'literal', value: 70 },
      });
    } else {
      entryChildren.push({
        type: 'condition', id: 'rsi_oversold',
        left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi1', offset: 0 },
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

  if (hasBias) {
    indicators.push({
      id: 'bias1', indicatorId: 'bias', params: { period: 20 },
      outputs: [{ key: 'bias', label: 'BIAS20', type: 'number' }],
    });
    entryChildren.push({
      type: 'condition', id: 'bias_rebound',
      left: { type: 'indicator', nodeId: 'bias1', output: 'bias', offset: 0 },
      operator: 'lt', right: { type: 'literal', value: -0.08 },
    });
    exitChildren.push({
      type: 'condition', id: 'bias_overheat',
      left: { type: 'indicator', nodeId: 'bias1', output: 'bias', offset: 0 },
      operator: 'gt', right: { type: 'literal', value: 0.08 },
    });
  }

  if (hasVolatility) {
    indicators.push({
      id: 'volatility1', indicatorId: 'volatility', params: { period: 20 },
      outputs: [
        { key: 'volatility', label: '波动率20', type: 'number' },
        { key: 'annualVolatility', label: '年化波动率20', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'volatility_filter',
      left: { type: 'indicator', nodeId: 'volatility1', output: 'annualVolatility', offset: 0 },
      operator: 'lt', right: { type: 'literal', value: 0.35 },
    });
  }

  if (hasVolCluster) {
    indicators.push({
      id: 'vol_cluster1', indicatorId: 'volCluster', params: { period: 20 },
      outputs: [{ key: 'volCluster', label: '波动聚集20', type: 'number' }],
    });
    entryChildren.push({
      type: 'condition', id: 'vol_cluster_filter',
      left: { type: 'indicator', nodeId: 'vol_cluster1', output: 'volCluster', offset: 0 },
      operator: 'lt', right: { type: 'literal', value: 0.6 },
    });
  }

  if (hasHold) {
    indicators.push({
      id: 'hold1', indicatorId: 'hold', params: {},
      outputs: [
        { key: 'holdReturn', label: 'HOLD收益', type: 'number' },
        { key: 'holdNav', label: 'HOLD净值', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'hold_positive',
      left: { type: 'indicator', nodeId: 'hold1', output: 'holdReturn', offset: 0 },
      operator: 'gt', right: { type: 'literal', value: 0 },
    });
  }

  if (hasReversal) {
    indicators.push({
      id: 'reversal1', indicatorId: 'reversal', params: { period: 20 },
      outputs: [{ key: 'reversal', label: '反转20', type: 'number' }],
    });
    entryChildren.push({
      type: 'condition', id: 'reversal_entry',
      left: { type: 'indicator', nodeId: 'reversal1', output: 'reversal', offset: 0 },
      operator: 'gt', right: { type: 'literal', value: 0.08 },
    });
    exitChildren.push({
      type: 'condition', id: 'reversal_exit',
      left: { type: 'indicator', nodeId: 'reversal1', output: 'reversal', offset: 0 },
      operator: 'lt', right: { type: 'literal', value: -0.08 },
    });
  }

  if (hasVolume) {
    indicators.push({
      id: 'volume1', indicatorId: 'volume', params: { period: 20 },
      outputs: [
        { key: 'volume', label: '成交量', type: 'number' },
        { key: 'volumeAverage', label: '20日均量', type: 'number' },
        { key: 'volumeRatio', label: '量比', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'volume_expansion',
      left: { type: 'indicator', nodeId: 'volume1', output: 'volumeRatio', offset: 0 },
      operator: 'gt', right: { type: 'literal', value: 1.5 },
    });
  }

  if (hasBreakout) {
    indicators.push({
      id: 'breakout1', indicatorId: 'highLowBreakout', params: { period: 20 },
      outputs: [
        { key: 'previousHigh', label: '前20日高点', type: 'number' },
        { key: 'previousLow', label: '前20日低点', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'break_high',
      left: { type: 'market', field: 'close', offset: 0 },
      operator: 'gt',
      right: { type: 'indicator', nodeId: 'breakout1', output: 'previousHigh', offset: 0 },
    });
    exitChildren.push({
      type: 'condition', id: 'break_low',
      left: { type: 'market', field: 'close', offset: 0 },
      operator: 'lt',
      right: { type: 'indicator', nodeId: 'breakout1', output: 'previousLow', offset: 0 },
    });
  }

  if (hasDrawdown) {
    indicators.push({
      id: 'drawdown1', indicatorId: 'drawdown', params: { period: 60 },
      outputs: [
        { key: 'peak', label: '60日峰值', type: 'number' },
        { key: 'drawdown', label: '60日回撤', type: 'number' },
      ],
    });
    entryChildren.push({
      type: 'condition', id: 'drawdown_entry',
      left: { type: 'indicator', nodeId: 'drawdown1', output: 'drawdown', offset: 0 },
      operator: 'gte', right: { type: 'literal', value: 0.08 },
    });
    exitChildren.push({
      type: 'condition', id: 'drawdown_recovered',
      left: { type: 'indicator', nodeId: 'drawdown1', output: 'drawdown', offset: 0 },
      operator: 'lte', right: { type: 'literal', value: 0.02 },
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
  if (prompt.includes('bias') || prompt.includes('乖离')) return '乖离率反转策略';
  if (prompt.includes('波动率') || prompt.includes('volatility')) return '波动率过滤策略';
  if (prompt.includes('波动聚集') || prompt.includes('volcluster')) return '波动聚集过滤策略';
  if (prompt.includes('hold') || prompt.includes('买入持有') || prompt.includes('持有收益')) return 'HOLD 对比策略';
  if (prompt.includes('反转') || prompt.includes('reversal')) return '反转因子策略';
  if (prompt.includes('突破') || prompt.includes('breakout')) return '高低点突破策略';
  if (prompt.includes('成交量') || prompt.includes('放量') || prompt.includes('volume')) return '量价策略';
  if (prompt.includes('回撤') || prompt.includes('drawdown')) return '回撤策略';
  return 'AI 生成策略';
}

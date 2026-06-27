import type {
  StrategyGenerationProvider,
  GenerateStrategyRequest,
  GenerateStrategyResult,
  RefineStrategyRequest,
  ExplainStrategyRequest,
  StrategyExplanation,
} from './provider.js';

/**
 * Mock provider for frontend development and testing without an API key.
 * Returns plausible strategy DSL based on prompt keywords.
 */
export class MockStrategyGenerationProvider implements StrategyGenerationProvider {
  async generate(request: GenerateStrategyRequest): Promise<GenerateStrategyResult> {
    // Simulate network latency
    await delay(800);

    const prompt = request.prompt.toLowerCase();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const hasMa = prompt.includes('均线') || prompt.includes('ma') || prompt.includes('sma');
    const hasRsi = prompt.includes('rsi');
    const hasMacd = prompt.includes('macd');
    const hasBoll = prompt.includes('布林') || prompt.includes('boll');
    const hasBias = prompt.includes('bias') || prompt.includes('乖离');
    const hasVolatility = prompt.includes('波动率') || prompt.includes('volatility');
    const hasVolCluster = prompt.includes('波动聚集') || prompt.includes('volcluster');
    const hasHold = prompt.includes('hold') || prompt.includes('买入持有') || prompt.includes('持有收益');
    const hasReversal = prompt.includes('反转') || prompt.includes('reversal');
    const hasVolume = prompt.includes('成交量') || prompt.includes('放量') || prompt.includes('缩量') || prompt.includes('volume');
    const hasBreakout = prompt.includes('突破') || prompt.includes('新高') || prompt.includes('新低') || prompt.includes('breakout');
    const hasDrawdown = prompt.includes('回撤') || prompt.includes('drawdown');
    const hasStopLoss = prompt.includes('止损');
    const hasTakeProfit = prompt.includes('止盈');

    const indicators: Record<string, unknown>[] = [];
    const entryConditions: unknown[] = [];
    const exitConditions: unknown[] = [];
    const risk: unknown[] = [];

    // Build indicators based on keywords
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

      entryConditions.push({
        type: 'condition',
        id: 'golden_cross',
        left: { type: 'indicator', nodeId: 'sma1', output: 'sma1', offset: 0 },
        operator: 'crossesAbove',
        right: { type: 'indicator', nodeId: 'sma1', output: 'sma2', offset: 0 },
      });

      exitConditions.push({
        type: 'condition',
        id: 'dead_cross',
        left: { type: 'indicator', nodeId: 'sma1', output: 'sma1', offset: 0 },
        operator: 'crossesBelow',
        right: { type: 'indicator', nodeId: 'sma1', output: 'sma2', offset: 0 },
      });
    }

    if (hasRsi) {
      indicators.push({
        id: 'rsi1',
        indicatorId: 'rsi',
        params: { period1: 6, period2: 12, period3: 24 },
        outputs: [
          { key: 'rsi1', label: 'RSI1', type: 'number' },
          { key: 'rsi2', label: 'RSI2', type: 'number' },
          { key: 'rsi3', label: 'RSI3', type: 'number' },
        ],
      });

      // Add RSI condition as additional entry filter
      if (entryConditions.length > 0) {
        entryConditions.splice(0, 0, {
          type: 'condition',
          id: 'rsi_filter',
          left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi1', offset: 0 },
          operator: 'lt',
          right: { type: 'literal', value: 70 },
        });
      } else {
        entryConditions.push({
          type: 'condition' as const,
          id: 'rsi_oversold',
          left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi1', offset: 0 },
          operator: 'lt',
          right: { type: 'literal', value: 30 },
        });
      }
    }

    if (hasMacd && !hasMa) {
      indicators.push({
        id: 'macd1',
        indicatorId: 'macd',
        params: { fast: 12, slow: 26, signal: 9 },
        outputs: [
          { key: 'dif', label: 'DIF', type: 'number' },
          { key: 'dea', label: 'DEA', type: 'number' },
        ],
      });

      entryConditions.push({
        type: 'condition',
        id: 'macd_golden',
        left: { type: 'indicator', nodeId: 'macd1', output: 'dif', offset: 0 },
        operator: 'crossesAbove',
        right: { type: 'indicator', nodeId: 'macd1', output: 'dea', offset: 0 },
      });
    }

    if (hasBoll && !hasMa) {
      indicators.push({
        id: 'boll1',
        indicatorId: 'boll',
        params: { period: 20, stdDev: 2 },
        outputs: [
          { key: 'upper', label: '上轨', type: 'number' },
          { key: 'middle', label: '中轨', type: 'number' },
          { key: 'lower', label: '下轨', type: 'number' },
        ],
      });

      entryConditions.push({
        type: 'condition',
        id: 'boll_lower_touch',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'crossesAbove',
        right: { type: 'indicator', nodeId: 'boll1', output: 'lower', offset: 0 },
      });
    }

    if (hasBias) {
      indicators.push({
        id: 'bias1',
        indicatorId: 'bias',
        params: { period: 20 },
        outputs: [{ key: 'bias', label: 'BIAS20', type: 'number' }],
      });
      entryConditions.push({
        type: 'condition',
        id: 'bias_rebound',
        left: { type: 'indicator', nodeId: 'bias1', output: 'bias', offset: 0 },
        operator: 'lt',
        right: { type: 'literal', value: -0.08 },
      });
      exitConditions.push({
        type: 'condition',
        id: 'bias_overheat',
        left: { type: 'indicator', nodeId: 'bias1', output: 'bias', offset: 0 },
        operator: 'gt',
        right: { type: 'literal', value: 0.08 },
      });
    }

    if (hasVolatility) {
      indicators.push({
        id: 'volatility1',
        indicatorId: 'volatility',
        params: { period: 20 },
        outputs: [
          { key: 'volatility', label: '波动率20', type: 'number' },
          { key: 'annualVolatility', label: '年化波动率20', type: 'number' },
        ],
      });
      entryConditions.push({
        type: 'condition',
        id: 'volatility_filter',
        left: { type: 'indicator', nodeId: 'volatility1', output: 'annualVolatility', offset: 0 },
        operator: 'lt',
        right: { type: 'literal', value: 0.35 },
      });
    }

    if (hasVolCluster) {
      indicators.push({
        id: 'vol_cluster1',
        indicatorId: 'volCluster',
        params: { period: 20 },
        outputs: [{ key: 'volCluster', label: '波动聚集20', type: 'number' }],
      });
      entryConditions.push({
        type: 'condition',
        id: 'vol_cluster_filter',
        left: { type: 'indicator', nodeId: 'vol_cluster1', output: 'volCluster', offset: 0 },
        operator: 'lt',
        right: { type: 'literal', value: 0.6 },
      });
    }

    if (hasHold) {
      indicators.push({
        id: 'hold1',
        indicatorId: 'hold',
        params: {},
        outputs: [
          { key: 'holdReturn', label: 'HOLD收益', type: 'number' },
          { key: 'holdNav', label: 'HOLD净值', type: 'number' },
        ],
      });
      entryConditions.push({
        type: 'condition',
        id: 'hold_positive',
        left: { type: 'indicator', nodeId: 'hold1', output: 'holdReturn', offset: 0 },
        operator: 'gt',
        right: { type: 'literal', value: 0 },
      });
    }

    if (hasReversal) {
      indicators.push({
        id: 'reversal1',
        indicatorId: 'reversal',
        params: { period: 20 },
        outputs: [{ key: 'reversal', label: '反转20', type: 'number' }],
      });
      entryConditions.push({
        type: 'condition',
        id: 'reversal_entry',
        left: { type: 'indicator', nodeId: 'reversal1', output: 'reversal', offset: 0 },
        operator: 'gt',
        right: { type: 'literal', value: 0.08 },
      });
      exitConditions.push({
        type: 'condition',
        id: 'reversal_exit',
        left: { type: 'indicator', nodeId: 'reversal1', output: 'reversal', offset: 0 },
        operator: 'lt',
        right: { type: 'literal', value: -0.08 },
      });
    }

    if (hasVolume) {
      indicators.push({
        id: 'volume1',
        indicatorId: 'volume',
        params: { period: 20 },
        outputs: [
          { key: 'volume', label: '成交量', type: 'number' },
          { key: 'volumeAverage', label: '20日均量', type: 'number' },
          { key: 'volumeRatio', label: '量比', type: 'number' },
        ],
      });
      entryConditions.push({
        type: 'condition',
        id: 'volume_expansion',
        left: { type: 'indicator', nodeId: 'volume1', output: 'volumeRatio', offset: 0 },
        operator: 'gt',
        right: { type: 'literal', value: 1.5 },
      });
    }

    if (hasBreakout) {
      indicators.push({
        id: 'breakout1',
        indicatorId: 'highLowBreakout',
        params: { period: 20 },
        outputs: [
          { key: 'previousHigh', label: '前20日高点', type: 'number' },
          { key: 'previousLow', label: '前20日低点', type: 'number' },
        ],
      });
      entryConditions.push({
        type: 'condition',
        id: 'break_high',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'gt',
        right: { type: 'indicator', nodeId: 'breakout1', output: 'previousHigh', offset: 0 },
      });
      exitConditions.push({
        type: 'condition',
        id: 'break_low',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'lt',
        right: { type: 'indicator', nodeId: 'breakout1', output: 'previousLow', offset: 0 },
      });
    }

    if (hasDrawdown) {
      indicators.push({
        id: 'drawdown1',
        indicatorId: 'drawdown',
        params: { period: 60 },
        outputs: [
          { key: 'peak', label: '60日峰值', type: 'number' },
          { key: 'drawdown', label: '60日回撤', type: 'number' },
        ],
      });
      entryConditions.push({
        type: 'condition',
        id: 'drawdown_entry',
        left: { type: 'indicator', nodeId: 'drawdown1', output: 'drawdown', offset: 0 },
        operator: 'gte',
        right: { type: 'literal', value: 0.08 },
      });
      exitConditions.push({
        type: 'condition',
        id: 'drawdown_recovered',
        left: { type: 'indicator', nodeId: 'drawdown1', output: 'drawdown', offset: 0 },
        operator: 'lte',
        right: { type: 'literal', value: 0.02 },
      });
    }

    if (hasStopLoss) {
      risk.push({ type: 'stopLoss', value: 8 });
    }

    if (hasTakeProfit) {
      risk.push({ type: 'takeProfit', value: 20 });
    }

    // Fallback: simple price > threshold
    if (entryConditions.length === 0) {
      indicators.push({
        id: 'sma1',
        indicatorId: 'sma',
        params: { period1: 10 },
        outputs: [{ key: 'sma1', label: 'SMA10', type: 'number' }],
      });
      entryConditions.push({
        type: 'condition',
        id: 'price_above_sma',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'gt',
        right: { type: 'indicator', nodeId: 'sma1', output: 'sma1', offset: 0 },
      });
      exitConditions.push({
        type: 'condition',
        id: 'price_below_sma',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'lt',
        right: { type: 'indicator', nodeId: 'sma1', output: 'sma1', offset: 0 },
      });
    }

    const strategy = {
      schemaVersion: '1.0',
      id,
      name: generateName(prompt),
      description: `AI 基于提示词生成的策略: "${request.prompt}"`,
      strategyVersion: 1,
      parameters: [],
      indicators,
      entry: {
        type: 'group',
        id: 'entry_root',
        operator: entryConditions.length > 1 ? 'all' : 'all',
        children: entryConditions,
      },
      exit: {
        type: 'group',
        id: 'exit_root',
        operator: 'any',
        children: exitConditions.length > 0 ? exitConditions : [
          { type: 'condition', id: 'fallback_exit', left: { type: 'literal', value: false }, operator: 'eq', right: { type: 'literal', value: true } },
        ],
      },
      risk,
      metadata: {
        source: 'ai',
        createdAt: now,
        updatedAt: now,
        aiGenerationId: id,
      },
    };

    return {
      generationId: id,
      strategy,
      summary: `基于 "${request.prompt}" 生成的策略，包含 ${indicators.length} 个技术指标和 ${risk.length} 个风控规则。`,
      warnings: [
        'AI 生成策略仅供参考，请在信号预览中验证后再用于实盘。',
        '请确认技术指标参数是否符合您的预期。',
      ],
      requiresConfirmation: true,
    };
  }

  async refine(request: RefineStrategyRequest): Promise<GenerateStrategyResult> {
    await delay(600);
    const updated = JSON.parse(JSON.stringify(request.currentStrategy));
    updated.metadata.updatedAt = new Date().toISOString();

    return {
      generationId: crypto.randomUUID(),
      strategy: updated,
      summary: `已根据 "${request.modification}" 调整策略。`,
      warnings: [],
      requiresConfirmation: true,
    };
  }

  async explain(request: ExplainStrategyRequest): Promise<StrategyExplanation> {
    await delay(400);
    const s = request.strategy;
    const indicatorNames = (s.indicators || []).map((i: Record<string, unknown>) => i.indicatorId).join('、');
    const riskCount = (s.risk || []).length;

    return {
      explanation: `该策略使用以下技术指标: ${indicatorNames || '无'}。` +
        `包含 ${riskCount} 个风控规则。` +
        `策略名称: ${s.name || '未命名'}。`,
      risks: [
        '技术指标存在滞后性，交叉信号可能出现在趋势末端。',
        '过拟合风险：策略可能在特定历史区间表现良好但泛化能力不足。',
      ],
      parameterNotes: '建议对关键参数进行不同市场环境下的鲁棒性测试。',
    };
  }
}

function generateName(prompt: string): string {
  if (prompt.includes('均线')) return '均线交叉策略';
  if (prompt.includes('RSI') || prompt.includes('rsi')) return 'RSI 策略';
  if (prompt.includes('MACD') || prompt.includes('macd')) return 'MACD 策略';
  if (prompt.includes('布林') || prompt.includes('BOLL')) return '布林带策略';
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

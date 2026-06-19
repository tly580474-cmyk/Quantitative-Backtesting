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
        params: { period: 14 },
        outputs: [{ key: 'rsi', label: 'RSI14', type: 'number' }],
      });

      // Add RSI condition as additional entry filter
      if (entryConditions.length > 0) {
        entryConditions.splice(0, 0, {
          type: 'condition',
          id: 'rsi_filter',
          left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi', offset: 0 },
          operator: 'lt',
          right: { type: 'literal', value: 70 },
        });
      } else {
        entryConditions.push({
          type: 'condition' as const,
          id: 'rsi_oversold',
          left: { type: 'indicator', nodeId: 'rsi1', output: 'rsi', offset: 0 },
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
  return 'AI 生成策略';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

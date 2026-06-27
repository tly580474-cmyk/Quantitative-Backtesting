import { describe, it, expect } from 'vitest';
import { compileToStrategyDefinition, compileAndValidate } from '../compiler';
import { validateDocument } from '../validator';
import type { VisualStrategyDocument, ConditionRule, RuleGroup } from '../types';
import type { Candle } from '@/models';

// ---- Test helpers ----

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: `2021-01-${String(i + 1).padStart(2, '0')}`,
    symbol: 'TEST',
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000000,
  }));
}

function makeEntryGroup(children: (ConditionRule | RuleGroup)[]): RuleGroup {
  return { type: 'group', id: 'entry', operator: 'all', children };
}

function makeExitGroup(children: (ConditionRule | RuleGroup)[]): RuleGroup {
  return { type: 'group', id: 'exit', operator: 'all', children };
}

function makeDoc(overrides: Partial<VisualStrategyDocument> = {}): VisualStrategyDocument {
  return {
    schemaVersion: '1.0',
    id: 'test-strategy',
    name: 'Test Strategy',
    description: '',
    strategyVersion: 1,
    parameters: [],
    indicators: [],
    entry: makeEntryGroup([
      {
        type: 'condition',
        id: 'c1',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'gt',
        right: { type: 'literal', value: 10 },
      },
    ]),
    exit: makeExitGroup([
      {
        type: 'condition',
        id: 'c2',
        left: { type: 'market', field: 'close', offset: 0 },
        operator: 'lt',
        right: { type: 'literal', value: 5 },
      },
    ]),
    risk: [],
    metadata: {
      source: 'visual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function runEvaluate(
  doc: VisualStrategyDocument,
  candles: Candle[],
  position: { quantity: number; avgCost: number } = { quantity: 0, avgCost: 0 },
) {
  const strategy = compileToStrategyDefinition(doc);
  const signals: { action: string; reason: string; index: number }[] = [];

  for (let i = 0; i < candles.length; i++) {
    const ctx = {
      index: i,
      candles: candles.slice(0, i + 1),
      indicators: {},
      position: { quantity: position.quantity, avgCost: position.avgCost },
    };
    const signal = strategy.evaluate(ctx, {});
    signals.push({ action: signal.action, reason: signal.reason, index: i });
  }
  return { strategy, signals };
}

// ---- Tests ----

describe('compileToStrategyDefinition', () => {
  // ---- Basic compilation ----

  it('compiles a valid document into a StrategyDefinition', () => {
    const doc = makeDoc();
    const strategy = compileToStrategyDefinition(doc);
    expect(strategy.id).toBe('test-strategy');
    expect(strategy.name).toBe('Test Strategy');
    expect(strategy.version).toBe('1');
    expect(typeof strategy.evaluate).toBe('function');
    expect(typeof strategy.warmupBars).toBe('function');
  });

  it('compileAndValidate returns success for valid doc', () => {
    const result = compileAndValidate(makeDoc());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.strategy.id).toBe('test-strategy');
    }
  });

  it('compileAndValidate returns errors for invalid doc', () => {
    const result = compileAndValidate({ invalid: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  // ---- Simple condition: close > literal ----

  it('evaluates close > literal correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'gt',
          right: { type: 'literal', value: 15 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([10, 12, 14, 16, 18, 20]);
    const { signals } = runEvaluate(doc, candles);

    const buySignals = signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
    // First buy should be at index 3 (close=16 > 15)
    expect(buySignals[0].index).toBe(3);
  });

  // ---- Comparison operators ----

  it('evaluates gte correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'gte',
          right: { type: 'literal', value: 15 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([10, 15, 20]);
    const { signals } = runEvaluate(doc, candles);
    // Index 1: close=15 >= 15 → buy
    expect(signals[1].action).toBe('buy');
  });

  it('evaluates lt correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'lt',
          right: { type: 'literal', value: 8 },
        },
      ]),
    });
    const candles = candlesFromCloses([10, 9, 7, 6]);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 10 });
    const sellSignals = signals.filter((s) => s.action === 'sell');
    expect(sellSignals.length).toBeGreaterThan(0);
  });

  it('evaluates lte correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'lte',
          right: { type: 'literal', value: 10 },
        },
      ]),
    });
    const candles = candlesFromCloses([12, 10, 8]);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 11 });
    // Index 1: close=10 <= 10 → sell
    expect(signals[1].action).toBe('sell');
  });

  it('evaluates eq approximately', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'eq',
          right: { type: 'literal', value: 10 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([8, 9, 10, 11]);
    const { signals } = runEvaluate(doc, candles);
    // close=10 at index 2 should match
    expect(signals[2].action).toBe('buy');
  });

  it('evaluates between correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'between',
          right: { type: 'literal', value: 13 },
          upper: { type: 'literal', value: 17 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([10, 12, 15, 18, 20]);
    const { signals } = runEvaluate(doc, candles);
    // close=15 at index 2 is in [13, 17]
    expect(signals[2].action).toBe('buy');
  });

  // ---- Cross operators ----

  it('evaluates crossesAbove correctly', () => {
    const doc = makeDoc({
      indicators: [
        {
          id: 'ind1',
          indicatorId: 'sma',
          params: { period1: 3 },
          outputs: [{ key: 'sma1', label: 'SMA3', type: 'number' }],
        },
      ],
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'crossesAbove',
          right: { type: 'indicator', nodeId: 'ind1', output: 'sma1', offset: 0 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    // Closes: flat at 10, then jump to 20 → close crosses above SMA3
    const closes = [10, 10, 10, 20, 20, 20];
    const candles = candlesFromCloses(closes);
    const { signals } = runEvaluate(doc, candles);

    const buySignals = signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
  });

  it('evaluates crossesBelow correctly', () => {
    const doc = makeDoc({
      indicators: [
        {
          id: 'ind1',
          indicatorId: 'sma',
          params: { period1: 3 },
          outputs: [{ key: 'sma1', label: 'SMA3', type: 'number' }],
        },
      ],
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'crossesBelow',
          right: { type: 'indicator', nodeId: 'ind1', output: 'sma1', offset: 0 },
        },
      ]),
    });
    // Closes: high then drop → close crosses below SMA3
    const closes = [20, 20, 20, 10, 10, 10];
    const candles = candlesFromCloses(closes);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 15 });

    const sellSignals = signals.filter((s) => s.action === 'sell');
    expect(sellSignals.length).toBeGreaterThan(0);
  });

  // ---- Nested logic (AND/OR/NOT) ----

  it('evaluates AND group correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'gt',
          right: { type: 'literal', value: 10 },
        },
        {
          type: 'condition',
          id: 'c2',
          left: { type: 'market', field: 'volume', offset: 0 },
          operator: 'gt',
          right: { type: 'literal', value: 500000 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([8, 12, 15]);
    const { signals } = runEvaluate(doc, candles);
    // Both conditions should be true at index 2
    expect(signals[2].action).toBe('buy');
  });

  it('evaluates OR group correctly', () => {
    const doc = makeDoc({
      entry: {
        type: 'group',
        id: 'entry',
        operator: 'any',
        children: [
          {
            type: 'condition',
            id: 'c1',
            left: { type: 'market', field: 'close', offset: 0 },
            operator: 'gt',
            right: { type: 'literal', value: 20 },
          },
          {
            type: 'condition',
            id: 'c2',
            left: { type: 'market', field: 'close', offset: 0 },
            operator: 'lt',
            right: { type: 'literal', value: 5 },
          },
        ],
      },
    });
    doc.exit.children = [];
    const candles = candlesFromCloses([6, 4, 3]);
    const { signals } = runEvaluate(doc, candles);
    // close=4 at index 1: < 5 → buy (even though not > 20)
    expect(signals[1].action).toBe('buy');
  });

  it('evaluates NOT group correctly', () => {
    const doc = makeDoc({
      entry: {
        type: 'group',
        id: 'entry',
        operator: 'not',
        children: [
          {
            type: 'condition',
            id: 'c1',
            left: { type: 'market', field: 'close', offset: 0 },
            operator: 'lt',
            right: { type: 'literal', value: 10 },
          },
        ],
      },
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([8, 12, 15]);
    const { signals } = runEvaluate(doc, candles);
    // Index 0: close=8 < 10 = true, NOT → false → no buy
    expect(signals[0].action).toBe('hold');
    // Index 1: close=12 < 10 = false, NOT → true → buy
    expect(signals[1].action).toBe('buy');
  });

  // ---- Risk rules ----

  it('triggers stop loss', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([]),
      risk: [{ type: 'stopLoss', value: 10 }],
    });
    // Bought at avgCost=20, current price=17 → loss = -15% (exceeds -10% stop loss)
    const candles = candlesFromCloses([22, 20, 18, 17, 16]);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 20 });

    const sellSignals = signals.filter((s) => s.action === 'sell');
    expect(sellSignals.length).toBeGreaterThan(0);
    expect(sellSignals.some((s) => s.reason.includes('止损'))).toBe(true);
  });

  it('triggers take profit', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([]),
      risk: [{ type: 'takeProfit', value: 10 }],
    });
    // Bought at avgCost=20, current price=23 → profit = +15% (exceeds +10% take profit)
    const candles = candlesFromCloses([20, 21, 23, 24]);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 20 });

    const sellSignals = signals.filter((s) => s.action === 'sell');
    expect(sellSignals.length).toBeGreaterThan(0);
    expect(sellSignals.some((s) => s.reason.includes('止盈'))).toBe(true);
  });

  it('does not trigger stop loss when within range', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([]),
      risk: [{ type: 'stopLoss', value: 10 }],
    });
    // Bought at avgCost=20, current price=19 → loss = -5% (within -10% stop loss)
    const candles = candlesFromCloses([22, 20, 19, 18.5]);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 20 });

    const sellSignals = signals.filter((s) => s.action === 'sell');
    expect(sellSignals).toHaveLength(0);
  });

  // ---- Indicator operands ----

  it('evaluates SMA indicator condition', () => {
    const doc = makeDoc({
      indicators: [
        {
          id: 'ind1',
          indicatorId: 'sma',
          params: { period1: 3 },
          outputs: [{ key: 'sma1', label: 'SMA3', type: 'number' }],
        },
      ],
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'gt',
          right: { type: 'indicator', nodeId: 'ind1', output: 'sma1', offset: 0 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const closes = [10, 10, 10, 20, 20, 20];
    const candles = candlesFromCloses(closes);
    const { signals } = runEvaluate(doc, candles);

    // At some point close should be > SMA3
    const buySignals = signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
  });

  // ---- Warmup period ----

  it('returns hold during warmup period', () => {
    const doc = makeDoc({
      indicators: [
        {
          id: 'ind1',
          indicatorId: 'sma',
          params: { period1: 20 },
          outputs: [{ key: 'sma1', label: 'SMA20', type: 'number' }],
        },
      ],
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'indicator', nodeId: 'ind1', output: 'sma1', offset: 0 },
          operator: 'gt',
          right: { type: 'literal', value: 0 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses(Array.from({ length: 25 }, (_, i) => 10 + i));
    const { signals } = runEvaluate(doc, candles);

    // First few bars should be warmup
    const earlySignals = signals.slice(0, 19);
    for (const s of earlySignals) {
      expect(s.reason).toContain('预热');
    }
  });

  // ---- Parity with built-in strategies ----

  it('matches dualMa golden cross buy signal', () => {
    // Express dual MA as DSL:
    // entry: SMA(short) crossesAbove SMA(long)
    const shortPeriod = 5;
    const longPeriod = 20;

    const doc: VisualStrategyDocument = {
      schemaVersion: '1.0',
      id: 'dualMa-dsl',
      name: '双均线交叉 DSL',
      description: 'DSL version of dual MA strategy',
      strategyVersion: 1,
      parameters: [
        { name: 'shortPeriod', label: '短期均线周期', type: 'number', defaultValue: shortPeriod },
        { name: 'longPeriod', label: '长期均线周期', type: 'number', defaultValue: longPeriod },
      ],
      indicators: [
        {
          id: 'shortSma',
          indicatorId: 'sma',
          params: { period1: shortPeriod },
          outputs: [{ key: 'sma1', label: '短期SMA', type: 'number' }],
        },
        {
          id: 'longSma',
          indicatorId: 'sma',
          params: { period1: longPeriod },
          outputs: [{ key: 'sma1', label: '长期SMA', type: 'number' }],
        },
      ],
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'goldenCross',
          left: { type: 'indicator', nodeId: 'shortSma', output: 'sma1', offset: 0 },
          operator: 'crossesAbove',
          right: { type: 'indicator', nodeId: 'longSma', output: 'sma1', offset: 0 },
        },
      ]),
      exit: makeEntryGroup([
        {
          type: 'condition',
          id: 'deadCross',
          left: { type: 'indicator', nodeId: 'shortSma', output: 'sma1', offset: 0 },
          operator: 'crossesBelow',
          right: { type: 'indicator', nodeId: 'longSma', output: 'sma1', offset: 0 },
        },
      ]),
      risk: [],
      metadata: { source: 'visual', createdAt: '', updatedAt: '' },
    };

    // Flat for 20 bars, then sharp rise — short crosses above long
    const closes = Array.from({ length: 30 }, (_, i) =>
      i < 20 ? 10 : 10 + (i - 19) * 2,
    );
    const candles = candlesFromCloses(closes);
    const { signals } = runEvaluate(doc, candles);

    const buySignals = signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
  });

  it('matches smaCross buy signal (close crosses above SMA)', () => {
    const period = 30;

    const doc: VisualStrategyDocument = {
      schemaVersion: '1.0',
      id: 'smaCross-dsl',
      name: 'SMA价格穿越 DSL',
      description: 'DSL version of SMA cross strategy',
      strategyVersion: 1,
      parameters: [
        { name: 'period', label: 'SMA周期', type: 'number', defaultValue: period },
      ],
      indicators: [
        {
          id: 'sma',
          indicatorId: 'sma',
          params: { period1: period },
          outputs: [{ key: 'sma1', label: `SMA${period}`, type: 'number' }],
        },
      ],
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'priceCrossAboveSma',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'crossesAbove',
          right: { type: 'indicator', nodeId: 'sma', output: 'sma1', offset: 0 },
        },
      ]),
      exit: makeEntryGroup([
        {
          type: 'condition',
          id: 'priceCrossBelowSma',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'crossesBelow',
          right: { type: 'indicator', nodeId: 'sma', output: 'sma1', offset: 0 },
        },
      ]),
      risk: [],
      metadata: { source: 'visual', createdAt: '', updatedAt: '' },
    };

    // Flat for 30 bars, then rise
    const closes = Array.from({ length: 40 }, (_, i) =>
      i < 30 ? 10 : 10 + (i - 29) * 1.5,
    );
    const candles = candlesFromCloses(closes);
    const { signals } = runEvaluate(doc, candles);

    const buySignals = signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
  });

  // ---- Historical offset ----

  it('evaluates historical offset correctly', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: -2 },
          operator: 'lt',
          right: { type: 'market', field: 'close', offset: 0 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    // close 2 bars ago < current close → rising trend
    const candles = candlesFromCloses([10, 8, 12, 15, 11]);
    const { signals } = runEvaluate(doc, candles);
    // Index 2: close[-2]=10, close[0]=12 → 10 < 12 → buy
    expect(signals[2].action).toBe('buy');
  });

  // ---- Empty exit/entry falls through ----

  it('returns hold when entry group is empty', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([10, 20, 30]);
    const { signals } = runEvaluate(doc, candles);
    for (const s of signals) {
      expect(s.action).toBe('hold');
    }
  });

  // ---- Percentage-based gradual position changes ----

  it('keeps emitting buy signals while holding so the engine can add by percentage', () => {
    const doc = makeDoc({
      entry: makeEntryGroup([
        {
          type: 'condition',
          id: 'c1',
          left: { type: 'market', field: 'close', offset: 0 },
          operator: 'gt',
          right: { type: 'literal', value: 5 },
        },
      ]),
      exit: makeEntryGroup([]),
    });
    const candles = candlesFromCloses([10, 15, 20]);
    const { signals } = runEvaluate(doc, candles, { quantity: 100, avgCost: 10 });

    const buySignals = signals.filter((s) => s.action === 'buy');
    expect(buySignals.length).toBeGreaterThan(0);
  });
});

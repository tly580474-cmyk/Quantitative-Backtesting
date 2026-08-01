import type { BacktestConfig, BacktestResult, Candle, StrategyDefinition } from '@/models';
import { runBacktestAsync } from '@/features/backtest/engine';

export interface RobustnessObservation {
  caseId: string;
  totalReturn: number;
}

export interface RobustnessInput {
  candles: Candle[];
  strategy: StrategyDefinition;
  strategyParams: Record<string, number | boolean | string>;
  config: BacktestConfig;
  baseline: BacktestResult;
  maximumCases?: number;
}

export interface SampleIsolationPlan {
  ranges: Array<{
    kind: 'train' | 'validation' | 'locked_test';
    startIndex: number;
    endIndex: number;
  }>;
  walkForward: Array<{
    fold: number;
    validation: { startIndex: number; endIndex: number };
  }>;
}

export interface SampleIsolationResults {
  train?: { totalReturn: number };
  validation?: { totalReturn: number };
  lockedTest?: { totalReturn: number };
  walkForward: Array<{ totalReturn: number }>;
}

interface Case {
  id: string;
  params?: Record<string, number | boolean | string>;
  config?: BacktestConfig;
  candles?: Candle[];
  strategy?: StrategyDefinition;
}

export function buildRobustnessCases(input: RobustnessInput): Case[] {
  const cases: Case[] = [];
  for (const [name, value] of Object.entries(input.strategyParams)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
    for (const ratio of [-0.1, -0.05, 0.05, 0.1]) {
      cases.push({
        id: `parameter:${name}:${ratio > 0 ? '+' : ''}${ratio}`,
        params: { ...input.strategyParams, [name]: Number((value * (1 + ratio)).toPrecision(12)) },
      });
    }
  }
  for (const multiplier of [2, 3]) {
    cases.push({
      id: `cost:${multiplier}x`,
      config: {
        ...input.config,
        commissionRate: input.config.commissionRate * multiplier,
        minimumCommission: input.config.minimumCommission * multiplier,
        sellTaxRate: input.config.sellTaxRate * multiplier,
        slippageBps: input.config.slippageBps * multiplier,
      },
    });
  }
  if (input.candles.length > 15) {
    cases.push(
      { id: 'date:start:+5bars', candles: input.candles.slice(5) },
      { id: 'date:end:-5bars', candles: input.candles.slice(0, -5) },
    );
  }
  const delayed: StrategyDefinition = {
    ...input.strategy,
    id: `${input.strategy.id}:delay-1`,
    evaluate: (context, params) => {
      if (context.index < 1) {
        return { time: context.candles[context.index].time, action: 'hold', reason: '延迟扰动预热' };
      }
      return input.strategy.evaluate({ ...context, index: context.index - 1 }, params);
    },
  };
  cases.push({ id: 'delay:+1bar', strategy: delayed });
  return cases.slice(0, input.maximumCases ?? 24);
}

export async function runRobustnessCases(input: RobustnessInput): Promise<RobustnessObservation[]> {
  const cases = buildRobustnessCases(input);
  const observations: RobustnessObservation[] = [];
  for (const item of cases) {
    const candles = item.candles ?? input.candles;
    const result = await runBacktestAsync({
      candles,
      strategy: item.strategy ?? input.strategy,
      strategyParams: item.params ?? input.strategyParams,
      config: item.config ?? input.config,
      datasetId: input.baseline.datasetSnapshot.id,
      datasetName: input.baseline.datasetSnapshot.name,
      datasetChecksum: input.baseline.datasetSnapshot.checksum,
      resultName: `${input.baseline.name} · ${item.id}`,
    });
    if (result.status === 'completed') {
      observations.push({ caseId: item.id, totalReturn: result.metrics.totalReturn });
    }
  }
  return observations;
}

export async function runSampleIsolationPlan(
  input: RobustnessInput,
  plan: SampleIsolationPlan,
): Promise<SampleIsolationResults> {
  const output: SampleIsolationResults = { walkForward: [] };
  const runRange = async (startIndex: number, endIndex: number, name: string) => {
    const candles = input.candles.slice(startIndex, endIndex + 1);
    const result = await runBacktestAsync({
      candles, strategy: input.strategy, strategyParams: input.strategyParams, config: input.config,
      datasetId: input.baseline.datasetSnapshot.id,
      datasetName: input.baseline.datasetSnapshot.name,
      datasetChecksum: input.baseline.datasetSnapshot.checksum,
      resultName: `${input.baseline.name} · ${name}`,
    });
    if (result.status !== 'completed') throw new Error(`${name} 分段回测失败：${result.error ?? result.status}`);
    return { totalReturn: result.metrics.totalReturn };
  };
  for (const range of plan.ranges) {
    const value = await runRange(range.startIndex, range.endIndex, range.kind);
    if (range.kind === 'train') output.train = value;
    else if (range.kind === 'validation') output.validation = value;
    else output.lockedTest = value;
  }
  for (const fold of plan.walkForward) {
    output.walkForward.push(await runRange(
      fold.validation.startIndex,
      fold.validation.endIndex,
      `walk-forward-${fold.fold}`,
    ));
  }
  return output;
}

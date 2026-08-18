import type { Instrument, KlinePoint } from '@/features/marketData/types';

export const TRAINING_HISTORY_YEARS = 10;
export const TRAINING_LIQUIDITY_LOOKBACK = 20;
export const TRAINING_MIN_MEDIAN_AMOUNT = 10_000_000;
export const TRAINING_MIN_TRADED_DAYS = 15;

const RISK_NAME_PATTERN = /^(?:\*?ST|S\*?ST|退市)/i;

export interface TrainingCandidate {
  code: string;
  name: string;
  market: '沪市' | '深市';
}

export function toTrainingCandidate(instrument: Instrument): TrainingCandidate | null {
  const symbol = instrument.symbol.trim();
  const name = instrument.name.trim();
  if (instrument.type !== 'stock' || instrument.status !== 'active') return null;
  if (instrument.market !== 'SH' && instrument.market !== 'SZ') return null;
  if (instrument.delistDate || RISK_NAME_PATTERN.test(name)) return null;
  if (!/^\d{6}$/.test(symbol)) return null;
  return {
    code: symbol,
    name,
    market: instrument.market === 'SH' ? '沪市' : '深市',
  };
}

function subtractYears(date: string, years: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() - years);
  return parsed.toISOString().slice(0, 10);
}

function tradingAmount(bar: KlinePoint): number {
  if (Number.isFinite(bar.amount) && (bar.amount ?? 0) > 0) return bar.amount!;
  if (!Number.isFinite(bar.volume) || bar.volume <= 0) return 0;
  return bar.close * bar.volume;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function hasTrainingLiquidity(bars: KlinePoint[], decisionIndex: number): boolean {
  const start = Math.max(0, decisionIndex - TRAINING_LIQUIDITY_LOOKBACK + 1);
  const lookback = bars.slice(start, decisionIndex + 1);
  const tradedAmounts = lookback.map(tradingAmount).filter((value) => value > 0);
  return lookback.length === TRAINING_LIQUIDITY_LOOKBACK
    && tradedAmounts.length >= TRAINING_MIN_TRADED_DAYS
    && median(tradedAmounts) >= TRAINING_MIN_MEDIAN_AMOUNT;
}

export function reconstructQfqFromPreviousClose(bars: KlinePoint[]): KlinePoint[] {
  if (bars.length < 2) return bars.map((bar) => ({ ...bar }));
  const multipliers = bars.map(() => 1);
  for (let index = bars.length - 1; index > 0; index -= 1) {
    const priorClose = bars[index - 1].close;
    const officialPreviousClose = bars[index].previousClose;
    let eventRatio = 1;
    if (
      officialPreviousClose != null
      && Number.isFinite(officialPreviousClose)
      && officialPreviousClose > 0
      && priorClose > 0
    ) {
      const ratio = officialPreviousClose / priorClose;
      if (ratio >= 0.2 && ratio <= 5 && Math.abs(ratio - 1) >= 0.003) eventRatio = ratio;
    }
    multipliers[index - 1] = multipliers[index] * eventRatio;
  }
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return bars.map((bar, index) => ({
    ...bar,
    open: round(bar.open * multipliers[index]),
    high: round(bar.high * multipliers[index]),
    low: round(bar.low * multipliers[index]),
    close: round(bar.close * multipliers[index]),
    previousClose: bar.previousClose == null
      ? bar.previousClose
      : round(bar.previousClose * multipliers[index]),
  }));
}

export function eligibleDecisionIndices(
  bars: KlinePoint[],
  initialVisibleBars: number,
  minFutureBars: number,
  asOfDate = new Date().toISOString().slice(0, 10),
): number[] {
  if (bars.length === 0) return [];
  const earliestDate = subtractYears(asOfDate, TRAINING_HISTORY_YEARS);
  const firstWithinRange = bars.findIndex((bar) => bar.date >= earliestDate);
  if (firstWithinRange < 0) return [];

  const firstDecision = firstWithinRange + initialVisibleBars - 1;
  const lastDecision = bars.length - minFutureBars - 1;
  const indices: number[] = [];
  for (let index = firstDecision; index <= lastDecision; index += 1) {
    if (hasTrainingLiquidity(bars, index)) indices.push(index);
  }
  return indices;
}

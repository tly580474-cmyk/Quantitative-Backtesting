import type { DailyFactorMetric, LayerMetric } from '../definitions/schema.js';

export function summarizeFactorReport(daily: DailyFactorMetric[], layers: LayerMetric[]) {
  const sampleCount = daily.reduce((sum, item) => sum + item.sampleCount, 0);
  const icValues = daily.map((item) => item.ic).filter(isNumber);
  const rankIcValues = daily.map((item) => item.rankIc).filter(isNumber);
  const firstLayer = layers.find((item) => item.layer === 1);
  const lastLayer = layers.reduce<LayerMetric | undefined>(
    (max, item) => (max === undefined || item.layer > max.layer ? item : max),
    undefined,
  );
  return {
    sampleCount,
    tradingDays: daily.length,
    averageIc: averageOrNull(icValues),
    averageRankIc: averageOrNull(rankIcValues),
    icir: informationRatio(icValues),
    rankIcPositiveRate: rankIcValues.length
      ? rankIcValues.filter((value) => value > 0).length / rankIcValues.length
      : null,
    longShortSpread: isNumber(lastLayer?.averageReturn) && isNumber(firstLayer?.averageReturn)
      ? lastLayer.averageReturn - firstLayer.averageReturn
      : null,
  };
}

function informationRatio(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = averageOrNull(values);
  if (avg === null) return null;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  const stddev = Math.sqrt(variance);
  return stddev > 0 ? avg / stddev * Math.sqrt(252) : null;
}

function averageOrNull(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

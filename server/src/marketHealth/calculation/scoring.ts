export function quantile(values: number[], percentile: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, percentile));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function robustGoodScore(value: number, history: number[]): number | null {
  const median = quantile(history, 0.5);
  const q25 = quantile(history, 0.25);
  const q75 = quantile(history, 0.75);
  if (median == null || q25 == null || q75 == null) return null;
  if (q75 - q25 < 1e-12) return 50;
  return Math.min(100, Math.max(0, 50 + 25 * (value - median) / (q75 - q25)));
}

export type VolumeUnitCorrection = 'divide-by-100' | 'multiply-by-100';

export interface VolumeUnitEvidence {
  volume?: number | null;
  amount?: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeUnitDecision {
  volume: number | null;
  correction: VolumeUnitCorrection | null;
  factor: 0.01 | 1 | 100;
  impliedPriceBefore: number | null;
  impliedPriceAfter: number | null;
}

/**
 * Canonical storage uses shares. When amount is available, amount / volume is
 * the volume-weighted average price and must be compatible with the day's OHLC
 * range. A 100x unit error therefore produces an unambiguous 0.01x/100x price.
 *
 * The relaxed [0.5 * low, 2 * high] gate tolerates rounded upstream amounts,
 * while the 20x score-improvement requirement prevents corrections caused by
 * ordinary auction or rounding differences.
 */
export function normalizeVolumeToShares(
  evidence: VolumeUnitEvidence,
): VolumeUnitDecision {
  const rawVolume = finitePositive(evidence.volume);
  const amount = finitePositive(evidence.amount);
  const prices = [evidence.open, evidence.high, evidence.low, evidence.close]
    .filter((value) => Number.isFinite(value) && value > 0);
  if (rawVolume == null || amount == null || prices.length !== 4) {
    return unchanged(evidence.volume);
  }

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const typical = Math.exp(
    prices.reduce((sum, value) => sum + Math.log(value), 0) / prices.length,
  );
  const candidates = ([1, 0.01, 100] as const).flatMap((factor) => {
    const volume = rawVolume * factor;
    if (!Number.isSafeInteger(Math.round(volume)) || volume <= 0) return [];
    const impliedPrice = amount / volume;
    const plausible = impliedPrice >= low * 0.5 && impliedPrice <= high * 2;
    return [{
      factor,
      volume: Math.round(volume),
      impliedPrice,
      plausible,
      score: Math.abs(Math.log(impliedPrice / typical)),
    }];
  });
  const original = candidates.find((candidate) => candidate.factor === 1);
  const best = candidates
    .filter((candidate) => candidate.plausible)
    .sort((left, right) => left.score - right.score)[0];
  if (
    !original
    || !best
    || best.factor === 1
    || original.score - best.score < Math.log(20)
  ) {
    return {
      volume: Math.round(rawVolume),
      correction: null,
      factor: 1,
      impliedPriceBefore: amount / rawVolume,
      impliedPriceAfter: amount / rawVolume,
    };
  }

  return {
    volume: best.volume,
    correction: best.factor === 0.01 ? 'divide-by-100' : 'multiply-by-100',
    factor: best.factor,
    impliedPriceBefore: amount / rawVolume,
    impliedPriceAfter: best.impliedPrice,
  };
}

export function markVolumeUnitCorrection(
  sourceVersion: string,
  correction: VolumeUnitCorrection,
): string {
  const suffix = correction === 'divide-by-100' ? ':vol/100' : ':vol*100';
  return sourceVersion.includes(':vol/') || sourceVersion.includes(':vol*')
    ? sourceVersion
    : `${sourceVersion}${suffix}`.slice(0, 64);
}

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function unchanged(value: number | null | undefined): VolumeUnitDecision {
  return {
    volume: value == null || !Number.isFinite(value) ? null : Math.round(value),
    correction: null,
    factor: 1,
    impliedPriceBefore: null,
    impliedPriceAfter: null,
  };
}

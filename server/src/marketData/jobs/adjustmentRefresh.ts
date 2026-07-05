import {
  deriveCompressedFactors,
  validateReconstruction,
  type CompressedFactor,
  type PriceRow,
  type ReconstructionStats,
} from '../../historyImport/factor.js';

const QUALITY_RATIO = 0.995;
const EPSILON = 1e-8;

export interface AdjustmentRefreshPlan {
  changed: boolean;
  factors: CompressedFactor[];
  eventDate: string | null;
  priorTransform: { factor: number; offset: number };
  validation: ReconstructionStats;
  reason: 'unchanged' | 'missing_baseline' | 'insufficient_reference' | 'quality_failed' | 'changed';
}

export function hasCorporateActionSignal(
  storedPreviousClose: number | null | undefined,
  officialPreviousClose: number | null | undefined,
  tickSize = 0.01,
): boolean {
  if (
    storedPreviousClose == null
    || officialPreviousClose == null
    || !Number.isFinite(storedPreviousClose)
    || !Number.isFinite(officialPreviousClose)
    || storedPreviousClose <= 0
    || officialPreviousClose <= 0
  ) {
    return false;
  }
  return Math.abs(storedPreviousClose - officialPreviousClose) > tickSize + EPSILON;
}

export function buildAdjustmentRefreshPlan(
  existingFactors: CompressedFactor[],
  rawRows: PriceRow[],
  qfqRows: PriceRow[],
  tickSize = 0.01,
): AdjustmentRefreshPlan {
  if (existingFactors.length === 0) {
    return emptyPlan('missing_baseline');
  }

  const existingValidation = validateReconstruction(
    rawRows,
    qfqRows,
    existingFactors,
    'qfq',
    tickSize,
  );
  if (
    existingValidation.comparedPrices > 0
    && existingValidation.withinTickRatio >= QUALITY_RATIO
  ) {
    return {
      changed: false,
      factors: existingFactors,
      eventDate: null,
      priorTransform: { factor: 1, offset: 0 },
      validation: existingValidation,
      reason: 'unchanged',
    };
  }

  const derived = deriveCompressedFactors(rawRows, qfqRows, tickSize);
  if (
    derived.factors.length < 2
    || derived.latestAnchorMismatch
    || derived.qfqStats.withinTickRatio < QUALITY_RATIO
  ) {
    return {
      ...emptyPlan('insufficient_reference'),
      validation: derived.qfqStats,
    };
  }

  const sortedExisting = [...existingFactors].sort(byEffectiveDate);
  const sortedDerived = [...derived.factors].sort(byEffectiveDate);
  const recentStart = sortedDerived[0].effectiveDate;
  const oldAtStart = factorAt(sortedExisting, recentStart);
  const newAtStart = sortedDerived[0];
  if (Math.abs(oldAtStart.factor) < EPSILON) {
    return {
      ...emptyPlan('quality_failed'),
      validation: derived.qfqStats,
    };
  }

  const compositionFactor = newAtStart.factor / oldAtStart.factor;
  const compositionOffset = newAtStart.offset - compositionFactor * oldAtStart.offset;
  if (!Number.isFinite(compositionFactor) || compositionFactor <= 0 || !Number.isFinite(compositionOffset)) {
    return {
      ...emptyPlan('quality_failed'),
      validation: derived.qfqStats,
    };
  }

  const historical = sortedExisting
    .filter((factor) => factor.effectiveDate < recentStart)
    .map((factor) => ({
      effectiveDate: factor.effectiveDate,
      factor: factor.factor * compositionFactor,
      offset: factor.offset * compositionFactor + compositionOffset,
    }));
  const merged = compactFactors([...historical, ...sortedDerived]);
  const validation = validateReconstruction(rawRows, qfqRows, merged, 'qfq', tickSize);
  if (
    validation.comparedPrices === 0
    || validation.withinTickRatio < QUALITY_RATIO
  ) {
    return {
      ...emptyPlan('quality_failed'),
      validation,
    };
  }

  const eventDate = findLatestBoundary(sortedDerived);
  return {
    changed: true,
    factors: merged,
    eventDate,
    priorTransform: {
      factor: compositionFactor,
      offset: compositionOffset,
    },
    validation,
    reason: 'changed',
  };
}

function findLatestBoundary(factors: CompressedFactor[]): string | null {
  for (let index = factors.length - 1; index >= 1; index -= 1) {
    const current = factors[index];
    const previous = factors[index - 1];
    if (
      Math.abs(current.factor - previous.factor) > EPSILON
      || Math.abs(current.offset - previous.offset) > EPSILON
    ) {
      return current.effectiveDate;
    }
  }
  return null;
}

function factorAt(
  factors: CompressedFactor[],
  tradeDate: string,
): CompressedFactor {
  let result = factors[0];
  for (const factor of factors) {
    if (factor.effectiveDate > tradeDate) break;
    result = factor;
  }
  return result;
}

function compactFactors(factors: CompressedFactor[]): CompressedFactor[] {
  const result: CompressedFactor[] = [];
  for (const factor of factors.sort(byEffectiveDate)) {
    const previous = result[result.length - 1];
    if (
      previous
      && Math.abs(previous.factor - factor.factor) <= EPSILON
      && Math.abs(previous.offset - factor.offset) <= EPSILON
    ) {
      continue;
    }
    result.push(factor);
  }
  return result;
}

function emptyPlan(reason: AdjustmentRefreshPlan['reason']): AdjustmentRefreshPlan {
  return {
    changed: false,
    factors: [],
    eventDate: null,
    priorTransform: { factor: 1, offset: 0 },
    validation: {
      comparedPrices: 0,
      withinTickPrices: 0,
      withinTickRatio: 0,
      meanAbsoluteError: 0,
      maxAbsoluteError: 0,
      firstMismatchDate: null,
    },
    reason,
  };
}

function byEffectiveDate(a: CompressedFactor, b: CompressedFactor): number {
  return a.effectiveDate.localeCompare(b.effectiveDate);
}

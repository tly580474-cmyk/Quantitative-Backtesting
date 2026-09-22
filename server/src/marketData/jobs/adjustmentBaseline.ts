import { deriveCompressedFactors, type PriceRow } from '../../historyImport/factor.js';

/** Bootstrap only from a complete reference, never extrapolate a short window. */
export function buildAdjustmentBaseline(raw: PriceRow[], qfq: PriceRow[]) {
  if (!raw.length || !qfq.length) throw new Error('Empty raw or qfq history');
  for (const rows of [raw, qfq]) {
    if (new Set(rows.map(row => row.tradeDate)).size !== rows.length) {
      throw new Error('Duplicate reference dates');
    }
    for (const row of rows) {
      if ([row.open, row.high, row.low, row.close].some(value => !Number.isFinite(value))) {
        throw new Error('Non-finite reference price');
      }
    }
  }
  const referenceDates = new Set(qfq.map(row => row.tradeDate));
  if (raw.some(row => !referenceDates.has(row.tradeDate))) {
    throw new Error('Qfq reference does not cover every stored raw date');
  }
  const derived = deriveCompressedFactors(raw, qfq);
  if (derived.missingRawRows || derived.qfqOnlyEarlyRows.length) {
    throw new Error('Raw history does not cover every qfq reference date');
  }
  if (!derived.factors.length || derived.latestAnchorMismatch
    || derived.qfqStats.comparedPrices !== raw.length * 4
    || derived.qfqStats.withinTickRatio < 0.995
    || derived.factors.some(factor => !Number.isFinite(factor.factor)
      || factor.factor <= 0 || !Number.isFinite(factor.offset))) {
    throw new Error('Baseline reconstruction or latest anchor failed');
  }
  return derived;
}

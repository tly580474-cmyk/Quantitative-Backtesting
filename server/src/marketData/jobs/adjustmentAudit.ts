import type { CompressedFactor, PriceRow } from '../../historyImport/factor.js';

export interface AuditBar extends PriceRow { previousClose: number | null; sourceKey?: number }
export interface AdjustmentDiscontinuity {
  date: string;
  priorDate: string;
  priorClose: number;
  officialPreviousClose: number;
  adjustedPriorClose: number;
  adjustedReferenceClose: number;
  difference: number;
  rawCorporateAction: boolean;
  previousCloseSourceKey?: number;
}

/** Screen each day's stored previous close against the prior adjusted close.
 * Imported source 1 previousClose may be the raw prior close, so discrepancies
 * are candidates for independent verification, never automatic repair authority.
 */
export function auditAdjustmentContinuity(
  bars: AuditBar[], factors: CompressedFactor[], start: string,
) {
  const structural: string[] = [];
  if (!factors.length) structural.push('missing_factors');
  if (new Set(factors.map(f => f.effectiveDate)).size !== factors.length) structural.push('duplicate_factor_dates');
  if (factors.some(f => !Number.isFinite(f.factor) || f.factor <= 0 || !Number.isFinite(f.offset))) {
    structural.push('invalid_factor');
  }
  const sorted = [...factors].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const rows = [...bars].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  if (rows.length && sorted.length && sorted[0].effectiveDate > rows[0].tradeDate) structural.push('factor_starts_after_prices');
  const mismatches: AdjustmentDiscontinuity[] = [];
  const missingPreviousClose: string[] = [];
  let compared = 0;
  let corporateActions = 0;
  let maxDifference = 0;
  const at = (date: string) => {
    let value = sorted[0];
    for (const f of sorted) { if (f.effectiveDate > date) break; value = f; }
    return value;
  };
  const anchor = sorted.at(-1);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.tradeDate < start) continue;
    if (!Number.isFinite(row.previousClose) || !row.previousClose || row.previousClose <= 0) {
      missingPreviousClose.push(row.tradeDate); continue;
    }
    if (i === 0 || !anchor || structural.length) continue;
    const prior = rows[i - 1];
    const a = at(prior.tradeDate); const b = at(row.tradeDate);
    const adjustedPriorClose = (prior.close * a.factor + a.offset - anchor.offset) / anchor.factor;
    const adjustedReferenceClose = (row.previousClose * b.factor + b.offset - anchor.offset) / anchor.factor;
    const difference = Math.abs(adjustedReferenceClose - adjustedPriorClose);
    const rawCorporateAction = Math.abs(prior.close - row.previousClose) > 0.01000001;
    compared++;
    if (rawCorporateAction) corporateActions++;
    maxDifference = Math.max(maxDifference, difference);
    // Two independently rounded one-tick reconstructions plus sub-tick quote rounding.
    if (difference > 0.02500001) mismatches.push({ date: row.tradeDate, priorDate: prior.tradeDate,
      priorClose: prior.close, officialPreviousClose: row.previousClose,
      adjustedPriorClose, adjustedReferenceClose, difference, rawCorporateAction, previousCloseSourceKey: row.sourceKey });
  }
  return { structural, compared, corporateActions, maxDifference, mismatches, missingPreviousClose };
}

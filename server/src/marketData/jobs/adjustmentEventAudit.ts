import type { CompressedFactor, PriceRow } from '../../historyImport/factor.js';

export interface DistributionEvent {
  date: string;
  cashPerShare: number;
  sharesPerShare: number;
}

/** An independent event-price check, not a replacement for a market-price reference.
 * Distributions excluding repurchased shares can use a different effective cash amount;
 * report those disagreements instead of automatically changing the database.
 */
export function auditDistributionEvents(
  bars: (PriceRow & { previousClose?: number | null; sourceKey?: number })[],
  factors: CompressedFactor[], events: DistributionEvent[],
) {
  const sorted = [...factors].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const prices = [...bars].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const at = (date: string) => sorted.filter(f => f.effectiveDate <= date).at(-1);
  const anchor = sorted.at(-1);
  return events.map(event => {
    const prior = prices.filter(b => b.tradeDate < event.date).at(-1);
    const next = prices.find(b => b.tradeDate >= event.date);
    if (!prior || !next || !anchor) return { ...event, status: 'missing_prices_or_factors' };
    const before = at(prior.tradeDate); const after = at(next.tradeDate);
    if (!before || !after || !Number.isFinite(event.cashPerShare) || event.cashPerShare < 0
      || !Number.isFinite(event.sharesPerShare) || event.sharesPerShare < 0) {
      return { ...event, status: 'invalid_event_or_factor' };
    }
    const theoreticalReference = (prior.close - event.cashPerShare) / (1 + event.sharesPerShare);
    const adjustedPrior = (prior.close * before.factor + before.offset - anchor.offset) / anchor.factor;
    const adjustedTheoretical = (theoreticalReference * after.factor + after.offset - anchor.offset) / anchor.factor;
    const difference = Math.abs(adjustedPrior - adjustedTheoretical);
    // Source 1 was imported with previousClose=raw prior close, not the exchange ex-reference.
    const usableQuoteReference = next.tradeDate === event.date && next.sourceKey !== 1
      && next.previousClose != null && Number.isFinite(next.previousClose) && next.previousClose > 0;
    const quoteDifference = usableQuoteReference ? Math.abs(theoreticalReference - next.previousClose!) : null;
    const status = quoteDifference != null && quoteDifference > 0.01500001 ? 'event_quote_disagreement'
      : difference > 0.02500001 ? 'factor_event_disagreement' : 'event_consistent';
    return { ...event, status, priorDate: prior.tradeDate, nextDate: next.tradeDate,
      priorClose: prior.close, theoreticalReference, quoteReference: usableQuoteReference ? next.previousClose : null,
      quoteDifference, adjustedPrior, adjustedTheoretical, difference };
  });
}

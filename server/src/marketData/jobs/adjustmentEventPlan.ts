import { validateReconstruction, type CompressedFactor, type PriceRow } from '../../historyImport/factor.js';
import { auditDistributionEvents, type DistributionEvent } from './adjustmentEventAudit.js';

export interface SinaFactor { d: string; f: string }
type EventBar = PriceRow & { previousClose?: number | null; sourceKey?: number };

/** Generate an exact cash/split transformation only after two independent event
 * sources agree. Formula reconstruction is kept distinct from observed qfq prices.
 */
export function buildEventValidatedPlan(input: {
  start: string; end: string; raw: EventBar[]; factors: CompressedFactor[];
  events: DistributionEvent[]; sina: SinaFactor[];
}) {
  const { start, end } = input;
  const raw = [...input.raw].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const factors = [...input.factors].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const events = [...input.events].sort((a, b) => a.date.localeCompare(b.date));
  const sina = [...input.sina].sort((a, b) => a.d.localeCompare(b.d));
  const at = (date: string) => factors.filter(f => f.effectiveDate <= date).at(-1);
  const sinaAt = (date: string) => sina.filter(f => f.d <= date).at(-1);
  const window = raw.filter(r => r.tradeDate >= start && r.tradeDate <= end);
  if (!window.length || !factors.length || !sina.length) throw new Error('Missing audit input');
  if (factors.some(f => !Number.isFinite(f.factor) || f.factor <= 0 || !Number.isFinite(f.offset))
    || sina.some(f => !Number.isFinite(Number(f.f)) || Number(f.f) <= 0)) throw new Error('Invalid factors');
  if (factors.at(-1)!.effectiveDate > end) throw new Error('Published factors extend beyond audit anchor');
  if (sina.some((f, index) => index > 0 && f.d > end && Math.abs(Number(f.f) / Number(sina[index - 1].f) - 1) > 1e-10)) {
    throw new Error('Independent source has a newer corporate action beyond audit anchor');
  }
  if (new Set(events.map(e => e.date)).size !== events.length) throw new Error('Duplicate event dates');
  if (new Set(sina.map(f => f.d)).size !== sina.length) throw new Error('Duplicate independent factor dates');
  const eventDates = new Set(events.map(e => e.date));
  const boundaries = sina.filter((f, index) => index > 0 && f.d >= start && f.d <= end
    && Math.abs(Number(f.f) / Number(sina[index - 1].f) - 1) > 1e-10);
  if (boundaries.some(f => !eventDates.has(f.d))) throw new Error('Sina contains an unaccounted corporate action');
  const checks = auditDistributionEvents(raw, factors, events);
  const independentChecks = events.map((event, index) => {
    if (event.date < start || event.date > end || !(event.cashPerShare >= 0) || !(event.sharesPerShare >= 0)) {
      throw new Error('Invalid distribution event');
    }
    const prior = raw.filter(r => r.tradeDate < event.date).at(-1);
    const next = raw.find(r => r.tradeDate >= event.date);
    const priorSina = prior && sinaAt(prior.tradeDate);
    const currentSina = sinaAt(event.date);
    if (!prior || !next || next.tradeDate !== event.date || !priorSina || !currentSina) {
      throw new Error('Event does not have complete ex-date evidence');
    }
    const expected = (prior.close - event.cashPerShare) / (1 + event.sharesPerShare);
    const independent = prior.close * Number(currentSina.f) / Number(priorSina.f);
    // A rounded one-cent difference can hide a real small dividend. Require an
    // independent factor boundary even if the rounded ex-reference is unchanged.
    if ((event.cashPerShare > 0 || event.sharesPerShare > 0) && !boundaries.some(f => f.d === event.date)) {
      throw new Error('Distribution missing from independent factor source');
    }
    if (Math.abs(expected - independent) > 0.00500001) throw new Error('Independent event amounts disagree');
    if (checks[index].status === 'event_quote_disagreement') throw new Error('Exchange reference disagrees with event');
    return { date: event.date, expected, independent, difference: Math.abs(expected - independent) };
  });
  // An unexplained existing boundary might be a rights issue or reorganisation.
  // Never replace it with a distribution-only model.
  for (let index = 1; index < factors.length; index++) {
    const f = factors[index];
    if (f.effectiveDate < start || f.effectiveDate > end || eventDates.has(f.effectiveDate)) continue;
    const prior = raw.filter(r => r.tradeDate < f.effectiveDate).at(-1);
    const previous = factors[index - 1];
    if (prior && (['open', 'high', 'low', 'close'] as const).some(k =>
      Math.abs(prior[k] * (f.factor - previous.factor) + f.offset - previous.offset) / factors.at(-1)!.factor > 0.025)) {
      throw new Error('Published series contains an unexplained boundary');
    }
  }
  let factor = 1; let offset = 0;
  const derived: CompressedFactor[] = [];
  for (const event of [...events].reverse()) {
    derived.unshift({ effectiveDate: event.date, factor, offset });
    factor /= 1 + event.sharesPerShare;
    offset -= event.cashPerShare * factor;
  }
  derived.unshift({ effectiveDate: raw[0].tradeDate, factor, offset });
  const before = at(raw[0].tradeDate);
  if (!before) throw new Error('Missing published baseline before window');
  const priorTransform = { factor: factor / before.factor, offset: offset - factor / before.factor * before.offset };
  const historical = factors.filter(f => f.effectiveDate < raw[0].tradeDate).map(f => ({
    effectiveDate: f.effectiveDate, factor: f.factor * priorTransform.factor,
    offset: f.offset * priorTransform.factor + priorTransform.offset,
  }));
  const merged = [...historical, ...derived];
  const formulaQfq = window.map(row => {
    const f = derived.filter(f => f.effectiveDate <= row.tradeDate).at(-1)!;
    return { tradeDate: row.tradeDate, open: row.open * f.factor + f.offset,
      high: row.high * f.factor + f.offset, low: row.low * f.factor + f.offset, close: row.close * f.factor + f.offset };
  });
  const beforeValidation = validateReconstruction(window, formulaQfq, factors, 'qfq');
  const validation = validateReconstruction(window, formulaQfq, merged, 'qfq');
  if (validation.withinTickRatio !== 1 || validation.maxAbsoluteError > 1e-7) throw new Error('Formula composition failed');
  return { changed: beforeValidation.withinTickRatio < 0.995 || beforeValidation.maxAbsoluteError > 0.025, factors: merged, priorTransform,
    independentChecks, beforeValidation, validation, formulaQfq,
    validationMethod: 'eastmoney_distribution_formula+sina_event_ratio+available_exchange_reference' };
}

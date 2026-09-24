import { describe, expect, it } from 'vitest';
import { auditDistributionEvents } from './adjustmentEventAudit.js';

const bars = [
  { tradeDate: '2026-07-09', open: 24.27, high: 24.27, low: 24.27, close: 24.27, sourceKey: 2 },
  { tradeDate: '2026-07-10', open: 18.4, high: 18.99, low: 17.88, close: 18.63, previousClose: 18.48, sourceKey: 2 },
];
const event = { date: '2026-07-10', cashPerShare: 0.25, sharesPerShare: 0.3 };
describe('independent distribution audit', () => {
  it('detects the missing Hualu split and passes the official transformation', () => {
    expect(auditDistributionEvents(bars, [{ effectiveDate: '2002-06-20', factor: 1, offset: 0 }], [event])[0])
      .toMatchObject({ status: 'factor_event_disagreement' });
    expect(auditDistributionEvents(bars, [
      { effectiveDate: '2002-06-20', factor: 1 / 1.3, offset: -0.25 / 1.3 },
      { effectiveDate: '2026-07-10', factor: 1, offset: 0 },
    ], [event])[0]).toMatchObject({ status: 'event_consistent' });
  });
  it('does not mistake imported prior raw close for an exchange reference', () => {
    const imported = bars.map(b => ({ ...b, sourceKey: 1, previousClose: 24.27 }));
    expect(auditDistributionEvents(imported, [{ effectiveDate: '2002-06-20', factor: 1, offset: 0 }], [event])[0])
      .toMatchObject({ status: 'factor_event_disagreement', quoteReference: null });
  });
  it('separates cash-distribution source conflicts from factor faults', () => {
    expect(auditDistributionEvents(bars, [{ effectiveDate: '2002-06-20', factor: 1, offset: 0 }],
      [{ ...event, cashPerShare: 0.5 }])[0]).toMatchObject({ status: 'event_quote_disagreement' });
  });
});

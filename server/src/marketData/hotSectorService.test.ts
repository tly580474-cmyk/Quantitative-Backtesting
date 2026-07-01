import { describe, expect, it } from 'vitest';
import { scoreHotSectorRows, type HotSectorSourceRow } from './hotSectorService.js';

const row = (patch: Partial<HotSectorSourceRow>): HotSectorSourceRow => ({
  code: 'BK001',
  name: '测试板块',
  type: 'industry',
  changePct: 1,
  amountYi: 10,
  mainNetInYi: 1,
  mainNetRatio: 2,
  advancers: 8,
  decliners: 2,
  leadingStock: '龙头股份',
  leadingStockChangePct: 5,
  ...patch,
});

describe('hot sector score', () => {
  it('ranks stronger momentum, capital and breadth first', () => {
    const result = scoreHotSectorRows([
      row({ code: 'BK001', name: '强势', changePct: 5, mainNetInYi: 8, mainNetRatio: 10, amountYi: 80, advancers: 18, decliners: 2 }),
      row({ code: 'BK002', name: '弱势', changePct: -2, mainNetInYi: -3, mainNetRatio: -5, amountYi: 2, advancers: 2, decliners: 18 }),
    ]);
    expect(result[0].name).toBe('强势');
    expect(result[0].rank).toBe(1);
    expect(result[0].signals).toContain('板块普涨');
  });

  it('rewards sectors that remain near the top', () => {
    const current = [row({ code: 'BK001' }), row({ code: 'BK002', changePct: 0 })];
    const previous = scoreHotSectorRows(current).map((item) => (
      item.code === 'BK001' ? { ...item, rank: 1 } : { ...item, rank: 80 }
    ));
    const next = scoreHotSectorRows(current, previous);
    const persisted = next.find((item) => item.code === 'BK001');
    expect(persisted?.scoreDetail.persistence).toBe(100);
    expect(persisted?.signals).toContain('热度延续');
  });
});

import { describe, expect, it } from 'vitest';
import sseFixture from './fixtures/dragon-tiger-sse.json' with { type: 'json' };
import szseFixture from './fixtures/dragon-tiger-szse.json' with { type: 'json' };
import {
  parseSseDragonTigerRows,
  parseSzseDragonTigerDetail,
  parseSzseDragonTigerRows,
} from './officialDragonTigerParsers.js';

describe('official dragon tiger parsers', () => {
  it('maps SSE market rows and embedded buy/sell seats', () => {
    const data = sseFixture;
    const result = parseSseDragonTigerRows(data.pageHelp.data);
    expect(result.items[0]).toMatchObject({ code: '603118', exchange: 'SH', sourceKey: 'sse' });
    expect(result.items[0]!.netBuyAmt).toBeCloseTo(244559935.54);
    expect(result.seats).toHaveLength(4);
    expect(result.seats[0]).toMatchObject({ side: 'buy', rank: 1, isInstitutional: true });
  });

  it('maps SZSE list and detail tabs without losing the official event identity', () => {
    const data = szseFixture;
    const market = parseSzseDragonTigerRows(data.market.data);
    expect(market.items[0]).toMatchObject({ code: '000566', exchange: 'SZ', changeType: '0902' });
    const detail = parseSzseDragonTigerDetail(data.detail, market.items[0]);
    expect(detail.items[0]).toMatchObject({ billboardDealAmt: 1703510157 });
    expect(detail.items[0]!.netBuyAmt).toBe(-34050025);
    expect(detail.seats).toHaveLength(2);
  });
});

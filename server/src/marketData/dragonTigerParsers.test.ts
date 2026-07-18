import { describe, expect, it } from 'vitest';
import marketFixture from './fixtures/dragon-tiger-market.json' with { type: 'json' };
import seatFixture from './fixtures/dragon-tiger-seats.json' with { type: 'json' };
import { parseDragonTigerMarketRows, parseDragonTigerSeatRows } from './dragonTigerParsers.js';

describe('dragon tiger parsers', () => {
  it('keeps multiple events for the same stock and trade date', () => {
    const items = parseDragonTigerMarketRows(marketFixture.result.data);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.tradeId)).size).toBe(2);
    expect(items.every((item) => item.code === '920305')).toBe(true);
    expect(items[0].sourceFingerprint).toHaveLength(64);
  });

  it('maps buy and sell seats and detects institutional seats', () => {
    const buy = parseDragonTigerSeatRows(seatFixture.buy, 'buy');
    const sell = parseDragonTigerSeatRows(seatFixture.sell, 'sell');
    expect(buy[0]).toMatchObject({ side: 'buy', isInstitutional: true, rank: 1 });
    expect(sell[0]).toMatchObject({ side: 'sell', isInstitutional: false, rank: 1 });
    expect(buy[0].sourceFingerprint).not.toBe(sell[0].sourceFingerprint);
  });
});

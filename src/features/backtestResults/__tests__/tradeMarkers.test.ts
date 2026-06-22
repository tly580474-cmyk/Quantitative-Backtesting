import { describe, expect, it } from 'vitest';
import type { Trade } from '@/models';
import { createTradeMarkers } from '../tradeMarkers';

function trade(time: string, side: Trade['side'], quantity = 1): Trade {
  return {
    id: `${time}-${side}`,
    orderId: `${time}-${side}-order`,
    time,
    side,
    quantity,
    rawPrice: 100,
    fillPrice: 100,
    commission: 0,
    tax: 0,
    slippageCost: 0,
    amount: 100,
  };
}

describe('trade markers', () => {
  it('sorts interleaved buy and sell markers chronologically', () => {
    const markers = createTradeMarkers([
      trade('2026-01-03', 'sell'),
      trade('2026-01-01', 'buy'),
      trade('2026-01-04', 'sell'),
      trade('2026-01-02', 'buy'),
    ]);

    expect(markers.map((marker) => marker.time)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(markers.map((marker) => marker.text)).toEqual(['买', '买', '卖', '卖']);
  });

  it('supports buy-only display and ignores rejected trades', () => {
    const markers = createTradeMarkers([
      trade('2026-01-03', 'buy'),
      trade('2026-01-01', 'sell'),
      trade('2026-01-02', 'buy', 0),
    ], ['buy']);

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      time: '2026-01-03',
      position: 'belowBar',
      shape: 'arrowUp',
      text: '买',
    });
  });
});


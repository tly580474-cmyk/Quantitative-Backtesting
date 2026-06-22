import type { BacktestResult } from '@/models';
import type { SeriesMarker, Time } from 'lightweight-charts';

type TradeSide = BacktestResult['trades'][number]['side'];

/**
 * lightweight-charts requires markers to be ordered by time. Build both buy
 * and sell markers in one pass, then sort them before handing them to the
 * series marker plugin.
 */
export function createTradeMarkers(
  trades: BacktestResult['trades'],
  sides: readonly TradeSide[] = ['buy', 'sell'],
): SeriesMarker<Time>[] {
  const visibleSides = new Set(sides);

  return trades
    .filter((trade) => trade.quantity > 0 && visibleSides.has(trade.side))
    .map((trade) => ({
      time: trade.time as Time,
      position: trade.side === 'buy' ? 'belowBar' as const : 'aboveBar' as const,
      color: trade.side === 'buy' ? '#E8590C' : '#2B8A3E',
      shape: trade.side === 'buy' ? 'arrowUp' as const : 'arrowDown' as const,
      text: trade.side === 'buy' ? '买' : '卖',
      size: 2,
    }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}


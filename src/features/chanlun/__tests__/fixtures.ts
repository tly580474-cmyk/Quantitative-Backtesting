import type { Candle } from '@/models';

const ranges: Array<[number, number]> = [
  [10, 8], [11, 9], [12, 10], [13, 11], [15, 13],
  [14, 12], [13, 11], [12, 10], [11, 9], [12, 10],
  [13, 11], [14, 12], [16, 14], [15, 13], [14, 12],
  [13, 11], [12, 10], [13, 11], [14, 12],
];

export const GOLDEN_CHAN_BARS: Candle[] = ranges.map(([high, low], index) => ({
  time: `2026-01-${String(index + 1).padStart(2, '0')}`,
  symbol: 'TEST',
  open: low + 0.5,
  high,
  low,
  close: high - 0.5,
  volume: 1_000 + index,
}));


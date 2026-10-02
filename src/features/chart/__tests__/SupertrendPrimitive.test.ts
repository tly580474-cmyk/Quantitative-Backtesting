import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, Logical, SeriesAttachedParameter, Time } from 'lightweight-charts';
import { getPriceColors } from '@/priceColors';
import { SupertrendPrimitive } from '../SupertrendPrimitive';

function setup() {
  const primitive = new SupertrendPrimitive();
  const times = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];
  const bars = times.map(() => ({ open: 10, high: 11, low: 9, close: 10 }));
  const update = vi.fn();
  primitive.attached({
    requestUpdate: update,
    chart: { timeScale: () => ({
      getVisibleLogicalRange: () => ({ from: 0, to: 4 }),
      options: () => ({ barSpacing: 10 }),
      timeToCoordinate: (time: Time) => times.indexOf(time as string) * 10,
    }) },
    series: { priceToCoordinate: (price: number) => 100 - price },
  } as unknown as SeriesAttachedParameter<Time>);
  primitive.setData(times, bars, { value: [14, 13, 8, 12, null], direction: [-1, -1, 1, -1, null] });
  const paths: number[][][] = [];
  let path: number[][] = [];
  const strokes: number[][][] = [];
  const fillColors: string[] = [];
  const strokeColors: string[] = [];
  const context = {
    fillStyle: '', strokeStyle: '',
    save: vi.fn(), restore: vi.fn(), closePath: vi.fn(),
    beginPath: () => { path = []; },
    moveTo: (x: number, y: number) => path.push([x, y]),
    lineTo: (x: number, y: number) => path.push([x, y]),
    fill: () => { paths.push(path); fillColors.push(context.fillStyle); },
    stroke: () => { strokes.push(path); strokeColors.push(context.strokeStyle); },
  };
  const draw = () => primitive.paneViews()[0].renderer()!.draw({
    useMediaCoordinateSpace: (cb: (scope: unknown) => void) => cb({ context, mediaSize: { width: 100, height: 100 } }),
  } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]);
  return { primitive, paths, strokes, draw, update, fillColors, strokeColors };
}

describe('Supertrend drawing', () => {
  it('recolors lines and fills without changing reversal geometry or indicator values', () => {
    const { primitive, draw, strokes, strokeColors, fillColors, update } = setup();
    draw();
    const geometry = strokes.slice();
    expect(strokeColors).toEqual(['#16a34a', '#ef4444', '#16a34a']);
    primitive.setColors(getPriceColors('green-up'));
    expect(update).toHaveBeenCalled();
    draw();
    expect(strokeColors.slice(3)).toEqual(['#ef4444', '#16a34a', '#ef4444']);
    expect(fillColors).toEqual(strokeColors);
    expect(strokes.slice(3)).toEqual(geometry);
    expect(primitive.autoscaleInfo(0 as Logical, 4 as Logical)).toEqual({ priceRange: { minValue: 8, maxValue: 14 } });
  });

  it('draws distinct paths and fills for reversals, including a single-bar trend', () => {
    const { primitive, paths, strokes, draw } = setup();
    draw();
    expect(primitive.paneViews()[0].zOrder?.()).toBe('bottom');
    expect(paths).toHaveLength(3);
    expect(strokes).toHaveLength(3);
    expect(strokes[0]).toEqual([[-5, 86], [0, 86], [10, 87], [15, 87]]);
    expect(strokes[1]).toEqual([[15, 92], [20, 92], [25, 92]]);
    expect(strokes[2]).toEqual([[25, 88], [30, 88], [35, 88]]);
    // The bullish singleton fill has area; no polygon crosses the reversal.
    expect(paths[1].map(([x]) => x)).toEqual([15, 20, 25, 25, 20, 15]);
  });

  it('includes visible bands in autoscale and removes them when hidden', () => {
    const { primitive, draw, paths, strokes, update } = setup();
    expect(primitive.autoscaleInfo(0 as Logical, 4 as Logical)).toEqual({ priceRange: { minValue: 8, maxValue: 14 } });
    primitive.setVisible(false);
    draw();
    expect(paths).toHaveLength(0);
    expect(strokes).toHaveLength(0);
    expect(primitive.autoscaleInfo(0 as Logical, 4 as Logical)).toBeNull();
    expect(update).toHaveBeenCalled();
    primitive.detached();
    primitive.setVisible(true);
    draw();
    expect(paths).toHaveLength(0);
  });
});

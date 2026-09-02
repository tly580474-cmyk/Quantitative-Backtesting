import { describe, expect, it } from 'vitest';
import {
  clipInfiniteLineToViewport,
  clipSegmentToViewport,
  hitTestDrawings,
  resolveDrawingGeometry,
} from '../geometry';
import type { Drawing, DrawingCoordinateAdapter, DrawingViewport } from '../types';

const viewport: DrawingViewport = { width: 100, height: 100 };
const adapter: DrawingCoordinateAdapter = {
  timeToCoordinate: (time) => Number(time),
  priceToCoordinate: (price) => price,
};

function drawing(type: Drawing['type'], points: Array<{ time: string; price: number }>): Drawing {
  return { id: `${type}-1`, contextKey: 'test', type, points };
}

describe('drawing geometry', () => {
  it('renders a horizontal drawing across the whole pane', () => {
    const geometry = resolveDrawingGeometry(
      drawing('horizontal', [{ time: '25', price: 42 }]),
      adapter,
      viewport,
    );

    expect(geometry?.anchors).toEqual([{ x: 25, y: 42 }]);
    expect(geometry?.strokes).toEqual([{ from: { x: 0, y: 42 }, to: { x: 100, y: 42 } }]);
  });

  it('clips finite segments to the pane bounds', () => {
    expect(clipSegmentToViewport(
      { x: -20, y: -20 },
      { x: 120, y: 120 },
      viewport,
    )).toEqual({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 } });
  });

  it('extends an infinite line through both opposite pane edges', () => {
    expect(clipInfiniteLineToViewport(
      { x: 25, y: 25 },
      { x: 75, y: 75 },
      viewport,
    )).toEqual([{ from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }]);
  });

  it('exposes all four rectangle corners and its body', () => {
    const geometry = resolveDrawingGeometry(
      drawing('rectangle', [{ time: '20', price: 80 }, { time: '75', price: 30 }]),
      adapter,
      viewport,
    );

    expect(geometry?.anchors).toEqual([
      { x: 20, y: 30 }, { x: 75, y: 30 }, { x: 75, y: 80 }, { x: 20, y: 80 },
    ]);
    expect(geometry?.body).toEqual({ left: 20, top: 30, width: 55, height: 50 });
    expect(geometry?.strokes).toHaveLength(4);
  });

  it('prioritizes an anchor over an overlapping stroke and body', () => {
    const rectangle = drawing('rectangle', [{ time: '20', price: 20 }, { time: '80', price: 80 }]);
    const horizontal = drawing('horizontal', [{ time: '20', price: 20 }]);
    const hit = hitTestDrawings([rectangle, horizontal], { x: 20, y: 20 }, adapter, viewport);

    expect(hit).toEqual({ drawingId: 'rectangle-1', part: 'anchor', anchorIndex: 0, distance: 0 });
  });

  it('returns rectangle body only when no stroke is close enough', () => {
    const rectangle = drawing('rectangle', [{ time: '20', price: 20 }, { time: '80', price: 80 }]);

    expect(hitTestDrawings([rectangle], { x: 50, y: 50 }, adapter, viewport)).toEqual({
      drawingId: 'rectangle-1', part: 'body', distance: 0,
    });
    expect(hitTestDrawings([rectangle], { x: 50, y: 22 }, adapter, viewport)).toEqual({
      drawingId: 'rectangle-1', part: 'stroke', distance: 2,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DrawingPrimitive } from '../DrawingPrimitive';
import type { Drawing } from '../types';

const drawing: Drawing = {
  id: 'trend-1',
  contextKey: '000001:day:none',
  type: 'segment',
  points: [
    { time: '10', price: 10 },
    { time: '90', price: 90 },
  ],
};

function attach(primitive: DrawingPrimitive) {
  const chart = {
    timeScale: () => ({ timeToCoordinate: (time: string | number) => Number(time) }),
    paneSize: () => ({ width: 100, height: 100 }),
  };
  const series = { priceToCoordinate: (price: number) => price };
  primitive.attached({
    chart,
    series,
    requestUpdate: vi.fn(),
  } as never);
}

describe('DrawingPrimitive', () => {
  it('exposes stable setters for completed, draft, and selected drawings', () => {
    const primitive = new DrawingPrimitive();
    const draft = { type: 'rectangle' as const, points: [{ time: '20', price: 20 }] };

    primitive.setDrawings([drawing]);
    primitive.setDraft(draft);
    primitive.setSelectedDrawing('trend-1');

    expect(primitive.getDrawings()).toEqual([drawing]);
    expect(primitive.getDraft()).toEqual(draft);
    expect(primitive.getSelectedDrawingId()).toBe('trend-1');
  });

  it('clears a selection when the selected drawing is removed', () => {
    const primitive = new DrawingPrimitive();
    primitive.setDrawings([drawing]);
    primitive.setSelectedDrawing(drawing.id);
    primitive.setDrawings([]);

    expect(primitive.getSelectedDrawingId()).toBeNull();
  });

  it('returns external ids and hit priorities for anchors and strokes', () => {
    const primitive = new DrawingPrimitive();
    attach(primitive);
    primitive.setDrawings([drawing]);

    const anchorHit = primitive.hitTest(10, 10);
    const strokeHit = primitive.hitTest(50, 50);

    expect(anchorHit).toMatchObject({
      externalId: 'drawing-trend-1-anchor-0',
      hitTestPriority: 2,
      cursorStyle: 'move',
    });
    expect(strokeHit).toMatchObject({
      externalId: 'drawing-trend-1-stroke',
      hitTestPriority: 1,
      cursorStyle: 'pointer',
    });
  });

  it('uses a body external id for rectangle interior hits', () => {
    const primitive = new DrawingPrimitive();
    attach(primitive);
    primitive.setDrawings([{
      ...drawing,
      id: 'rect-1',
      type: 'rectangle',
      points: [{ time: '20', price: 20 }, { time: '80', price: 80 }],
    }]);

    expect(primitive.hitTest(50, 50)).toMatchObject({
      externalId: 'drawing-rect-1-body',
      hitTestPriority: 0,
      cursorStyle: 'grab',
    });
  });
});

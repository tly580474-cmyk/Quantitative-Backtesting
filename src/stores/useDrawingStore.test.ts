import { beforeEach, describe, expect, it } from 'vitest';
import { useDrawingStore } from './useDrawingStore';
import { DRAWING_STORAGE_KEY } from './useDrawingStore';
import { DEFAULT_DRAWING_COLOR } from './useDrawingStore';

const point = (time: string, price: number) => ({ time, price });

function resetStore(): void {
  localStorage.clear();
  useDrawingStore.setState({
    contextKey: '',
    drawings: [],
    draft: null,
    selectedId: null,
    tool: 'select',
    color: DEFAULT_DRAWING_COLOR,
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
  });
}

beforeEach(resetStore);

describe('useDrawingStore', () => {
  it('partitions drawings by context and restores them from localStorage', () => {
    const id = useDrawingStore.getState().add({
      type: 'horizontal',
      points: [point('2026-01-02', 10)],
    });

    expect(id).toBeTruthy();
    expect(useDrawingStore.getState().drawings[0]?.contextKey).toBe('');

    useDrawingStore.getState().setContextKey('000001|day|qfq');
    expect(useDrawingStore.getState().drawings).toHaveLength(0);
    useDrawingStore.getState().add({ type: 'segment', points: [point('2026-01-02', 10), point('2026-01-03', 11)] });

    useDrawingStore.getState().setContextKey('');
    expect(useDrawingStore.getState().drawings.map((drawing) => drawing.id)).toEqual([id]);

    const persisted = JSON.parse(localStorage.getItem(DRAWING_STORAGE_KEY) ?? '{}') as {
      contexts?: Record<string, unknown[]>;
    };
    expect(persisted.contexts?.['000001|day|qfq']).toHaveLength(1);
    expect(persisted.contexts?.['']).toHaveLength(1);
  });

  it('supports update and selected deletion', () => {
    const id = useDrawingStore.getState().add({ type: 'horizontal', points: [point('2026-01-02', 10)] });
    expect(id).toBeTruthy();
    expect(useDrawingStore.getState().selectedId).toBe(id);

    expect(useDrawingStore.getState().update(id!, { points: [point('2026-01-02', 12)] })).toBe(true);
    expect(useDrawingStore.getState().drawings[0]?.points[0]?.price).toBe(12);
    expect(useDrawingStore.getState().delete()).toBe(true);
    expect(useDrawingStore.getState().drawings).toHaveLength(0);
    expect(useDrawingStore.getState().selectedId).toBeNull();
  });

  it('makes clear undoable and supports redo', () => {
    useDrawingStore.getState().add({ type: 'horizontal', points: [point('2026-01-02', 10)] });
    useDrawingStore.getState().add({ type: 'rectangle', points: [point('2026-01-02', 10), point('2026-01-03', 12)] });
    expect(useDrawingStore.getState().clear()).toBe(true);
    expect(useDrawingStore.getState().drawings).toHaveLength(0);
    expect(useDrawingStore.getState().canUndo).toBe(true);

    expect(useDrawingStore.getState().undo()).toBe(true);
    expect(useDrawingStore.getState().drawings).toHaveLength(2);
    expect(useDrawingStore.getState().canRedo).toBe(true);
    expect(useDrawingStore.getState().redo()).toBe(true);
    expect(useDrawingStore.getState().drawings).toHaveLength(0);
  });

  it('clears an unfinished draft without creating drawing history', () => {
    useDrawingStore.getState().setDraft({ type: 'segment', points: [point('2026-01-02', 10)] });
    expect(useDrawingStore.getState().draft?.type).toBe('segment');
    expect(useDrawingStore.getState().clear()).toBe(true);
    expect(useDrawingStore.getState().draft).toBeNull();
    expect(useDrawingStore.getState().canUndo).toBe(false);
  });

  it('stores the active color and persists a colored freehand path', () => {
    useDrawingStore.getState().setColor('#dc2626');
    useDrawingStore.getState().add({
      type: 'freehand',
      points: [
        { ...point('2026-01-02', 10), logical: -2.5 },
        { ...point('2026-01-03', 11), logical: 0.25 },
        { ...point('2026-01-04', 10.5), logical: 8.75 },
      ],
      style: { color: useDrawingStore.getState().color },
    });

    expect(useDrawingStore.getState().color).toBe('#DC2626');
    expect(useDrawingStore.getState().drawings[0]).toMatchObject({
      type: 'freehand',
      style: { color: '#DC2626' },
    });
    expect(useDrawingStore.getState().drawings[0]?.points[0]?.logical).toBe(-2.5);
    expect(JSON.parse(localStorage.getItem(DRAWING_STORAGE_KEY) ?? '{}')).toMatchObject({
      color: '#DC2626',
    });
  });
});

import { create } from 'zustand';
import type {
  Drawing,
  DrawingDraft,
  DrawingInput,
  DrawingPatch,
  DrawingTool,
} from '@/features/chart/drawing/types';
import { isDrawingType } from '@/features/chart/drawing/types';

const STORAGE_KEY = 'quant-backtest:drawing-store:v1';
const DEFAULT_CONTEXT_KEY = '';

interface PersistedDrawings {
  contexts?: Record<string, Drawing[]>;
}

export interface DrawingState {
  contextKey: string;
  drawings: Drawing[];
  draft: DrawingDraft | null;
  selectedId: string | null;
  tool: DrawingTool;
  past: Drawing[][];
  future: Drawing[][];
  canUndo: boolean;
  canRedo: boolean;

  setContextKey: (contextKey: string) => void;
  setTool: (tool: DrawingTool) => void;
  setDraft: (draft: DrawingDraft | null) => void;
  clearDraft: () => void;
  setSelectedId: (selectedId: string | null) => void;
  add: (drawing: DrawingInput) => string | null;
  update: (id: string, patch: DrawingPatch) => boolean;
  delete: (id?: string) => boolean;
  remove: (id?: string) => boolean;
  clear: () => boolean;
  undo: () => boolean;
  redo: () => boolean;
}

function cloneDrawings(drawings: readonly Drawing[]): Drawing[] {
  return drawings.map((drawing) => ({
    ...drawing,
    points: drawing.points.map((point) => ({ ...point })),
    style: drawing.style ? { ...drawing.style } : undefined,
  }));
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readPersisted(): PersistedDrawings {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const contexts = (parsed as PersistedDrawings).contexts;
    return contexts && typeof contexts === 'object' ? { contexts } : {};
  } catch {
    // A private browsing session or malformed old data must not make the
    // chart unusable. The in-memory store remains available in that case.
    return {};
  }
}

function isPoint(value: unknown): value is { time: string; price: number } {
  if (!value || typeof value !== 'object') return false;
  const point = value as { time?: unknown; price?: unknown };
  return typeof point.time === 'string'
    && point.time.length > 0
    && typeof point.price === 'number'
    && Number.isFinite(point.price);
}

function isStoredDrawing(value: unknown, contextKey: string): value is Drawing {
  if (!value || typeof value !== 'object') return false;
  const drawing = value as Partial<Drawing>;
  return typeof drawing.id === 'string'
    && drawing.id.length > 0
    && drawing.contextKey === contextKey
    && isDrawingType(drawing.type)
    && Array.isArray(drawing.points)
    && drawing.points.length > 0
    && drawing.points.every(isPoint);
}

function readContext(contextKey: string): Drawing[] {
  const contexts = readPersisted().contexts;
  if (!contexts || !hasOwn(contexts, contextKey) || !Array.isArray(contexts[contextKey])) {
    return [];
  }
  return cloneDrawings(contexts[contextKey].filter((item) => isStoredDrawing(item, contextKey)));
}

function persistContext(contextKey: string, drawings: readonly Drawing[]): void {
  if (typeof window === 'undefined') return;
  try {
    const persisted = readPersisted();
    const contexts = { ...(persisted.contexts ?? {}) };
    contexts[contextKey] = cloneDrawings(drawings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ contexts }));
  } catch {
    // Persistence is best-effort. Drawing in the current session must still
    // work when storage is full or disabled.
  }
}

function createDrawingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `drawing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function selectionFor(drawings: readonly Drawing[], selectedId: string | null): string | null {
  return selectedId && drawings.some((drawing) => drawing.id === selectedId) ? selectedId : null;
}

function withHistoryFlags(past: Drawing[][], future: Drawing[][]) {
  return {
    past,
    future,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  };
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  contextKey: DEFAULT_CONTEXT_KEY,
  drawings: readContext(DEFAULT_CONTEXT_KEY),
  draft: null,
  selectedId: null,
  tool: 'select',
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  setContextKey: (contextKey) => {
    const nextContextKey = contextKey ?? DEFAULT_CONTEXT_KEY;
    if (nextContextKey === get().contextKey) return;
    set({
      contextKey: nextContextKey,
      drawings: readContext(nextContextKey),
      draft: null,
      selectedId: null,
      ...withHistoryFlags([], []),
    });
  },

  setTool: (tool) => {
    if (tool === get().tool) return;
    set((state) => ({
      tool,
      draft: null,
      selectedId: tool === 'select' ? state.selectedId : null,
    }));
  },

  setDraft: (draft) => {
    if (draft && !isDrawingType(draft.type)) return;
    set({ draft: draft ? {
      type: draft.type,
      points: draft.points.map((point) => ({ ...point })),
      previewPoint: draft.previewPoint ? { ...draft.previewPoint } : undefined,
      style: draft.style ? { ...draft.style } : undefined,
    } : null });
  },

  clearDraft: () => set({ draft: null }),

  setSelectedId: (selectedId) => set((state) => ({
    selectedId: selectionFor(state.drawings, selectedId),
  })),

  add: (input) => {
    const state = get();
    if (!isDrawingType(input.type)) return null;
    if (input.contextKey != null && input.contextKey !== state.contextKey) return null;
    if (!Array.isArray(input.points) || input.points.length === 0 || !input.points.every(isPoint)) return null;

    const drawing: Drawing = {
      ...input,
      id: input.id && input.id.length > 0 ? input.id : createDrawingId(),
      contextKey: state.contextKey,
      points: input.points.map((point) => ({ ...point })),
      createdAt: input.createdAt ?? Date.now(),
    };
    const drawings = [...state.drawings, drawing];
    const past = [...state.past, cloneDrawings(state.drawings)];
    set({
      drawings,
      draft: null,
      selectedId: drawing.id,
      ...withHistoryFlags(past, []),
    });
    persistContext(state.contextKey, drawings);
    return drawing.id;
  },

  update: (id, patch) => {
    const state = get();
    const index = state.drawings.findIndex((drawing) => drawing.id === id);
    if (index < 0) return false;
    if (patch.type != null && !isDrawingType(patch.type)) return false;
    if (patch.points != null && (!Array.isArray(patch.points) || !patch.points.every(isPoint))) return false;
    const drawings = state.drawings.map((drawing, drawingIndex) => drawingIndex === index
      ? {
        ...drawing,
        ...patch,
        contextKey: state.contextKey,
        points: patch.points?.map((point) => ({ ...point })) ?? drawing.points.map((point) => ({ ...point })),
        style: patch.style ? { ...patch.style } : drawing.style ? { ...drawing.style } : undefined,
      }
      : drawing);
    set({
      drawings,
      selectedId: id,
      ...withHistoryFlags([...state.past, cloneDrawings(state.drawings)], []),
    });
    persistContext(state.contextKey, drawings);
    return true;
  },

  delete: (id) => {
    const state = get();
    const targetId = id ?? state.selectedId;
    if (!targetId || !state.drawings.some((drawing) => drawing.id === targetId)) return false;
    const drawings = state.drawings.filter((drawing) => drawing.id !== targetId);
    set({
      drawings,
      selectedId: null,
      ...withHistoryFlags([...state.past, cloneDrawings(state.drawings)], []),
    });
    persistContext(state.contextKey, drawings);
    return true;
  },

  remove: (id) => get().delete(id),

  clear: () => {
    const state = get();
    if (state.drawings.length === 0 && state.draft == null) return false;
    const nextPast = state.drawings.length > 0
      ? [...state.past, cloneDrawings(state.drawings)]
      : state.past;
    set({
      drawings: [],
      draft: null,
      selectedId: null,
      ...withHistoryFlags(nextPast, []),
    });
    persistContext(state.contextKey, []);
    return true;
  },

  undo: () => {
    const state = get();
    const previous = state.past[state.past.length - 1];
    if (!previous) return false;
    const past = state.past.slice(0, -1);
    const drawings = cloneDrawings(previous);
    const future = [cloneDrawings(state.drawings), ...state.future];
    set({
      drawings,
      draft: null,
      selectedId: selectionFor(drawings, state.selectedId),
      ...withHistoryFlags(past, future),
    });
    persistContext(state.contextKey, drawings);
    return true;
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return false;
    const future = state.future.slice(1);
    const drawings = cloneDrawings(next);
    const past = [...state.past, cloneDrawings(state.drawings)];
    set({
      drawings,
      draft: null,
      selectedId: selectionFor(drawings, state.selectedId),
      ...withHistoryFlags(past, future),
    });
    persistContext(state.contextKey, drawings);
    return true;
  },
}));

export { STORAGE_KEY as DRAWING_STORAGE_KEY };

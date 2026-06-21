import { create } from 'zustand';
import { produce } from 'immer';
import type { VisualStrategyDocument, ValidationResult } from '@/features/visualStrategies/types';
import type { StoredVisualStrategy } from '@/features/visualStrategies/types';
import { getRepository } from '@/api/useRepository';
import { validateDocument } from '@/features/visualStrategies/validator';

const MAX_UNDO = 50;

function createEmptyDocument(): VisualStrategyDocument {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    schemaVersion: '1.0',
    id,
    name: '未命名策略',
    description: '',
    strategyVersion: 1,
    parameters: [],
    indicators: [],
    entry: { type: 'group', id: 'entry-root', operator: 'all', children: [] },
    exit: { type: 'group', id: 'exit-root', operator: 'all', children: [] },
    risk: [],
    metadata: {
      source: 'visual',
      createdAt: now,
      updatedAt: now,
    },
  };
}

interface StrategyStudioState {
  // Document
  document: VisualStrategyDocument | null;
  documentId: string | null;

  // UI
  selectedNodeId: string | null;
  validationResult: ValidationResult | null;

  // Undo/redo
  undoStack: VisualStrategyDocument[];
  redoStack: VisualStrategyDocument[];

  // List
  strategies: StoredVisualStrategy[];

  // Dirty
  isDirty: boolean;

  // Actions
  createNew: () => void;
  loadStrategy: (id: string) => Promise<void>;
  pushUndo: () => void;
  updateDocument: (recipe: (draft: VisualStrategyDocument) => void) => void;
  undo: () => void;
  redo: () => void;
  selectNode: (nodeId: string | null) => void;
  validate: () => ValidationResult | null;
  save: () => Promise<void>;
  publish: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  loadList: () => Promise<void>;
  importDocument: (doc: VisualStrategyDocument) => void;
  exportDocument: () => VisualStrategyDocument | null;
}

export const useStrategyStudioStore = create<StrategyStudioState>((set, get) => ({
  document: null,
  documentId: null,
  selectedNodeId: null,
  validationResult: null,
  undoStack: [],
  redoStack: [],
  strategies: [],
  isDirty: false,

  createNew: () => {
    const doc = createEmptyDocument();
    set({
      document: doc,
      documentId: doc.id,
      undoStack: [],
      redoStack: [],
      selectedNodeId: null,
      validationResult: null,
      isDirty: false,
    });
  },

  loadStrategy: async (id: string) => {
    const stored = await getRepository().getVisualStrategyById(id);
    if (!stored) return;
    set({
      document: stored.document,
      documentId: stored.id,
      undoStack: [],
      redoStack: [],
      selectedNodeId: null,
      validationResult: null,
      isDirty: false,
    });
  },

  pushUndo: () => {
    const { document, undoStack } = get();
    if (!document) return;
    const newStack = [...undoStack, document];
    if (newStack.length > MAX_UNDO) newStack.shift();
    set({ undoStack: newStack, redoStack: [], isDirty: true });
  },

  updateDocument: (recipe) => {
    const { document } = get();
    if (!document) return;
    // Push current state to undo before mutation
    get().pushUndo();
    const next = produce(document, (draft) => {
      recipe(draft);
      draft.metadata.updatedAt = new Date().toISOString();
    });
    set({ document: next, isDirty: true });

    // Re-validate after a short debounce
    const result = validateDocument(next);
    set({ validationResult: result });
  },

  undo: () => {
    const { undoStack, document } = get();
    if (undoStack.length === 0 || !document) return;
    const prev = undoStack[undoStack.length - 1];
    const newUndo = undoStack.slice(0, -1);
    set({
      document: prev,
      undoStack: newUndo,
      redoStack: [...get().redoStack, document],
      isDirty: true,
    });
  },

  redo: () => {
    const { redoStack, document } = get();
    if (redoStack.length === 0 || !document) return;
    const next = redoStack[redoStack.length - 1];
    const newRedo = redoStack.slice(0, -1);
    set({
      document: next,
      redoStack: newRedo,
      undoStack: [...get().undoStack, document],
    });
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  validate: () => {
    const { document } = get();
    if (!document) return null;
    const result = validateDocument(document);
    set({ validationResult: result });
    return result;
  },

  save: async () => {
    const { document, documentId } = get();
    if (!document || !documentId) return;

    const stored: StoredVisualStrategy = {
      id: documentId,
      name: document.name,
      document,
      status: 'draft',
      createdAt: document.metadata.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await getRepository().saveVisualStrategy(stored);

    // Also save draft
    await getRepository().saveDraft({
      id: `draft_${documentId}`,
      strategyId: documentId,
      document,
      updatedAt: new Date().toISOString(),
    });

    set({ isDirty: false });
    await get().loadList();
  },

  publish: async () => {
    const { document, documentId } = get();
    if (!document || !documentId) return;

    // Validate before publishing — reject invalid strategies
    const vr = validateDocument(document);
    if (!vr.valid) {
      throw new Error(`策略校验未通过，无法发布:\n${vr.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
    }

    // Auto-save first so the strategy exists in the DB
    const stored: StoredVisualStrategy = {
      id: documentId,
      name: document.name,
      document,
      status: 'draft',
      createdAt: document.metadata.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await getRepository().saveVisualStrategy(stored);

    // Publish (creates immutable version)
    await getRepository().publishVisualStrategy(documentId, document);

    // Read back the published version to get the updated strategyVersion
    const versions = await getRepository().getVersionsForStrategy(documentId);
    const latestVersion = versions[versions.length - 1];
    const updatedDoc = latestVersion?.document ?? document;

    set({
      document: updatedDoc,
      isDirty: false,
    });
    await get().loadList();
  },

  remove: async (id: string) => {
    await getRepository().deleteVisualStrategy(id);
    await get().loadList();
    const { documentId } = get();
    if (documentId === id) {
      set({
        document: null,
        documentId: null,
        selectedNodeId: null,
        isDirty: false,
      });
    }
  },

  loadList: async () => {
    const strategies = await getRepository().getAllVisualStrategies();
    set({ strategies });
  },

  importDocument: (doc) => {
    const newDoc = {
      ...doc,
      id: crypto.randomUUID(),
      metadata: {
        ...doc.metadata,
        source: 'imported' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
    const validationResult = validateDocument(newDoc);
    set({
      document: newDoc,
      documentId: newDoc.id,
      undoStack: [],
      redoStack: [],
      selectedNodeId: null,
      validationResult,
      isDirty: true,
    });
  },

  exportDocument: () => {
    return get().document;
  },
}));

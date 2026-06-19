import { db } from './database';
import type {
  VisualStrategyDocument,
  StoredVisualStrategy,
  StoredStrategyVersion,
  StoredStrategyDraft,
} from '@/features/visualStrategies/types';

// ---- Visual Strategies ----

export async function getAllVisualStrategies(): Promise<StoredVisualStrategy[]> {
  return db.visualStrategies.orderBy('updatedAt').reverse().toArray();
}

export async function getVisualStrategyById(id: string): Promise<StoredVisualStrategy | undefined> {
  return db.visualStrategies.get(id);
}

export async function saveVisualStrategy(strategy: StoredVisualStrategy): Promise<void> {
  await db.visualStrategies.put(strategy);
}

export async function deleteVisualStrategy(id: string): Promise<void> {
  await db.transaction('rw', [db.visualStrategies, db.strategyVersions, db.strategyDrafts], async () => {
    await db.visualStrategies.delete(id);
    await db.strategyVersions.where('strategyId').equals(id).delete();
    await db.strategyDrafts.where('strategyId').equals(id).delete();
  });
}

export async function publishVisualStrategy(
  id: string,
  document: VisualStrategyDocument,
): Promise<void> {
  await db.transaction('rw', [db.visualStrategies, db.strategyVersions], async () => {
    const strategy = await db.visualStrategies.get(id);
    if (!strategy) throw new Error(`Strategy not found: ${id}`);

    const newVersion = (document.strategyVersion || strategy.document.strategyVersion || 0) + 1;
    const updatedDoc = { ...document, strategyVersion: newVersion };

    const version: StoredStrategyVersion = {
      id: `${id}_v${newVersion}`,
      strategyId: id,
      version: newVersion,
      document: updatedDoc,
      createdAt: new Date().toISOString(),
    };

    await db.strategyVersions.put(version);
    await db.visualStrategies.update(id, {
      document: updatedDoc,
      status: 'published',
      updatedAt: new Date().toISOString(),
    });
  });
}

// ---- Strategy versions ----

export async function getVersionsForStrategy(strategyId: string): Promise<StoredStrategyVersion[]> {
  return db.strategyVersions
    .where('strategyId')
    .equals(strategyId)
    .reverse()
    .sortBy('version');
}

export async function getStrategyVersion(
  strategyId: string,
  version: number,
): Promise<StoredStrategyVersion | undefined> {
  return db.strategyVersions.get(`${strategyId}_v${version}`);
}

// ---- Drafts ----

export async function saveDraft(draft: StoredStrategyDraft): Promise<void> {
  await db.strategyDrafts.put(draft);
}

export async function getDraftForStrategy(strategyId: string): Promise<StoredStrategyDraft | undefined> {
  return db.strategyDrafts.where('strategyId').equals(strategyId).first();
}

export async function deleteDraft(strategyId: string): Promise<void> {
  await db.strategyDrafts.where('strategyId').equals(strategyId).delete();
}

// ---- Import/Export ----

export function exportStrategyAsJson(document: VisualStrategyDocument): string {
  return JSON.stringify(document, null, 2);
}

export function parseImportedStrategy(json: string): VisualStrategyDocument {
  return JSON.parse(json) as VisualStrategyDocument;
}

export function downloadStrategyFile(doc: VisualStrategyDocument): void {
  const json = exportStrategyAsJson(doc);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = `${doc.name || doc.id}.json`;
  window.document.body.appendChild(a);
  a.click();
  window.document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

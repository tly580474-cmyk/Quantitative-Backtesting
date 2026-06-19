import { db } from './database';
import type { BacktestResult, EquityPoint } from '@/models';

export async function saveResult(
  result: BacktestResult,
  equityCurve: EquityPoint[],
): Promise<void> {
  await db.transaction('rw', db.backtestResults, db.equityPoints, async () => {
    await db.backtestResults.put(result);
    // Remove old equity points for this result
    await db.equityPoints.where('resultId').equals(result.id).delete();
    const points = equityCurve.map((p) => ({ ...p, resultId: result.id }));
    await db.equityPoints.bulkPut(points);
  });
}

export async function getResult(id: string): Promise<BacktestResult | undefined> {
  return db.backtestResults.get(id);
}

export async function getResults(): Promise<BacktestResult[]> {
  return db.backtestResults.orderBy('startedAt').reverse().toArray();
}

export async function deleteResult(id: string): Promise<void> {
  await db.transaction('rw', db.backtestResults, db.equityPoints, async () => {
    await db.backtestResults.delete(id);
    await db.equityPoints.where('resultId').equals(id).delete();
  });
}

export async function deleteResults(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction('rw', db.backtestResults, db.equityPoints, async () => {
    await db.backtestResults.bulkDelete(ids);
    await db.equityPoints.where('resultId').anyOf(ids).delete();
  });
}

export async function getEquityPoints(resultId: string): Promise<EquityPoint[]> {
  return db.equityPoints.where('resultId').equals(resultId).sortBy('time');
}

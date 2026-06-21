import { db } from './database';
import type { MarketDataset, StoredCandle, Candle } from '@/models';
import { computeDataChecksum } from '@/utils/checksum';

export async function saveDataset(
  dataset: MarketDataset,
  candles: Candle[],
): Promise<void> {
  const stored: StoredCandle[] = candles.map((c) => ({
    ...c,
    datasetId: dataset.id,
  }));

  await db.transaction('rw', db.marketDatasets, db.candles, async () => {
    await db.marketDatasets.put(dataset);
    await db.candles.bulkPut(stored);
  });
}

export async function getDataset(id: string): Promise<MarketDataset | undefined> {
  return db.marketDatasets.get(id);
}

export async function getDatasets(): Promise<MarketDataset[]> {
  return db.marketDatasets.orderBy('createdAt').reverse().toArray();
}

export async function getCandlesByDataset(datasetId: string): Promise<StoredCandle[]> {
  return db.candles.where('datasetId').equals(datasetId).sortBy('time');
}

export async function deleteDataset(id: string): Promise<void> {
  await db.transaction('rw', db.marketDatasets, db.candles, async () => {
    await db.marketDatasets.delete(id);
    await db.candles.where('datasetId').equals(id).delete();
  });
}

export async function findDuplicateByChecksum(cs: string): Promise<MarketDataset | undefined> {
  return db.marketDatasets.where('checksum').equals(cs).first();
}

export function computeChecksum(candles: Candle[]): string {
  return computeDataChecksum(candles);
}

export async function datasetExists(id: string): Promise<boolean> {
  const count = await db.marketDatasets.where('id').equals(id).count();
  return count > 0;
}

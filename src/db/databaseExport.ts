import * as XLSX from 'xlsx';
import { db } from './database';

function downloadWorkbook(workbook: XLSX.WorkBook, fileName: string): void {
  const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const url = URL.createObjectURL(new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function serializableRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value != null && typeof value === 'object' ? JSON.stringify(value) : value,
    ]),
  ));
}

export async function exportDatabaseToExcel(): Promise<string> {
  const workbook = XLSX.utils.book_new();
  const backtestResults = (await db.backtestResults.toArray()).map((result) => ({
    id: result.id,
    name: result.name,
    status: result.status,
    datasetSnapshot: result.datasetSnapshot,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    strategyParams: result.strategyParams,
    config: result.config,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    metrics: result.metrics,
    error: result.error ?? '',
    trades: result.trades,
    signals: result.signals,
  }));
  const sources: Array<[string, Record<string, unknown>[]]> = [
    ['数据集', await db.marketDatasets.toArray() as unknown as Record<string, unknown>[]],
    ['行情数据', await db.candles.toArray() as unknown as Record<string, unknown>[]],
    ['回测结果', backtestResults as unknown as Record<string, unknown>[]],
    ['权益曲线', await db.equityPoints.toArray() as unknown as Record<string, unknown>[]],
    ['策略配置', await db.strategyConfigs.toArray() as unknown as Record<string, unknown>[]],
    ['可视化策略', await db.visualStrategies.toArray() as unknown as Record<string, unknown>[]],
    ['策略版本', await db.strategyVersions.toArray() as unknown as Record<string, unknown>[]],
    ['策略草稿', await db.strategyDrafts.toArray() as unknown as Record<string, unknown>[]],
  ];
  for (const [name, rows] of sources) {
    const sheet = XLSX.utils.json_to_sheet(serializableRows(rows));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `量化回测数据库-${stamp}.xlsx`;
  downloadWorkbook(workbook, fileName);
  return fileName;
}

import * as XLSX from 'xlsx';
import { db } from './database';
import type { BacktestResult } from '@/models';

type CellValue = string | number | boolean | null;
type TableRow = Record<string, CellValue>;

interface ExportTable {
  name: string;
  rows: TableRow[];
  headers?: string[];
}

function downloadWorkbook(workbook: XLSX.WorkBook, fileName: string): void {
  const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellStyles: true });
  const url = URL.createObjectURL(new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function flattenRecord(
  value: unknown,
  prefix = '',
  target: TableRow = {},
): TableRow {
  if (value == null || typeof value !== 'object') {
    if (prefix) target[prefix] = value as CellValue;
    return target;
  }
  if (Array.isArray(value)) return target;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) continue;
    if (child != null && typeof child === 'object') flattenRecord(child, path, target);
    else target[path] = child as CellValue;
  }
  return target;
}

export function flattenLeaves(
  value: unknown,
  recordType: string,
  recordId: string,
  path = '',
  rows: TableRow[] = [],
): TableRow[] {
  if (value == null || typeof value !== 'object') {
    rows.push({ recordType, recordId, path, value: value as CellValue });
    return rows;
  }
  const entries = Array.isArray(value)
    ? value.map((child, index) => [String(index), child] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries) {
    flattenLeaves(child, recordType, recordId, path ? `${path}.${key}` : key, rows);
  }
  return rows;
}

function resultSummary(result: BacktestResult): TableRow {
  return flattenRecord({
    id: result.id,
    name: result.name,
    status: result.status,
    dataset: result.datasetSnapshot,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    strategyParams: result.strategyParams,
    config: result.config,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    metrics: result.metrics,
    error: result.error ?? '',
  });
}

function addTableSheet(workbook: XLSX.WorkBook, table: ExportTable): void {
  const headers = table.headers ?? Array.from(new Set(table.rows.flatMap((row) => Object.keys(row))));
  const sheet = XLSX.utils.json_to_sheet(table.rows, { header: headers, skipHeader: false });
  if (headers.length > 0) {
    const lastRow = Math.max(1, table.rows.length + 1);
    const lastColumn = XLSX.utils.encode_col(headers.length - 1);
    sheet['!autofilter'] = { ref: `A1:${lastColumn}${lastRow}` };
    sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    sheet['!cols'] = headers.map((header) => {
      const sampleWidth = table.rows.slice(0, 200).reduce(
        (max, row) => Math.max(max, String(row[header] ?? '').length),
        header.length,
      );
      return { wch: Math.min(32, Math.max(10, sampleWidth + 2)) };
    });
    for (let column = 0; column < headers.length; column++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })];
      if (cell) {
        cell.s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { patternType: 'solid', fgColor: { rgb: '1677FF' } },
          alignment: { horizontal: 'center', vertical: 'center' },
        };
      }
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, table.name);
}

export async function exportDatabaseToExcel(): Promise<string> {
  const [
    datasets,
    candles,
    results,
    equityPoints,
    strategyConfigs,
    visualStrategies,
    strategyVersions,
    strategyDrafts,
  ] = await Promise.all([
    db.marketDatasets.toArray(),
    db.candles.toArray(),
    db.backtestResults.toArray(),
    db.equityPoints.toArray(),
    db.strategyConfigs.toArray(),
    db.visualStrategies.toArray(),
    db.strategyVersions.toArray(),
    db.strategyDrafts.toArray(),
  ]);

  const strategyFieldRows: TableRow[] = [];
  visualStrategies.forEach((record) => flattenLeaves(record.document, 'visualStrategy', record.id, '', strategyFieldRows));
  strategyVersions.forEach((record) => flattenLeaves(record.document, 'strategyVersion', record.id, '', strategyFieldRows));
  strategyDrafts.forEach((record) => flattenLeaves(record.document, 'strategyDraft', record.id, '', strategyFieldRows));

  const tables: ExportTable[] = [
    { name: '数据集', rows: datasets.map((row) => flattenRecord(row)) },
    { name: '行情数据', rows: candles.map((row) => flattenRecord(row)) },
    { name: '回测结果', rows: results.map(resultSummary) },
    {
      name: '交易明细',
      rows: results.flatMap((result) => result.trades.map((trade) => ({
        resultId: result.id,
        resultName: result.name,
        ...flattenRecord(trade),
      }))),
    },
    {
      name: '信号明细',
      rows: results.flatMap((result) => result.signals.map((signal) => ({
        resultId: result.id,
        resultName: result.name,
        ...flattenRecord(signal),
      }))),
    },
    { name: '权益曲线', rows: equityPoints.map((row) => flattenRecord(row)) },
    { name: '策略配置', rows: strategyConfigs.map((row) => flattenRecord(row)) },
    {
      name: '可视化策略',
      rows: visualStrategies.map((row) => flattenRecord({
        id: row.id,
        name: row.name,
        status: row.status,
        schemaVersion: row.document.schemaVersion,
        strategyVersion: row.document.strategyVersion,
        source: row.document.metadata.source,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    },
    {
      name: '策略版本',
      rows: strategyVersions.map((row) => flattenRecord({
        id: row.id,
        strategyId: row.strategyId,
        version: row.version,
        name: row.document.name,
        createdAt: row.createdAt,
      })),
    },
    {
      name: '策略草稿',
      rows: strategyDrafts.map((row) => flattenRecord({
        id: row.id,
        strategyId: row.strategyId,
        name: row.document.name,
        updatedAt: row.updatedAt,
      })),
    },
    {
      name: '策略DSL字段',
      rows: strategyFieldRows,
      headers: ['recordType', 'recordId', 'path', 'value'],
    },
  ];

  const workbook = XLSX.utils.book_new();
  tables.forEach((table) => addTableSheet(workbook, table));
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `量化回测数据库-${stamp}.xlsx`;
  downloadWorkbook(workbook, fileName);
  return fileName;
}

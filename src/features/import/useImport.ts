import { useCallback, useState } from 'react';
import * as XLSX from 'xlsx';
import type { ImportResult } from '@/models';
import { parseSheetData } from './parser';
import { validateCandles } from './validator';

async function parseImportFile(file: File): Promise<ImportResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  const parseResult = parseSheetData(rows);
  const validationResult = validateCandles(parseResult.candles);
  const candles = validationResult.validCandles;
  return {
    success: [...parseResult.errors, ...validationResult.errors].length === 0 && candles.length > 0,
    fileName: file.name,
    symbol: candles[0]?.symbol ?? '',
    dateRange: candles.length > 0 ? { from: candles[0].time, to: candles[candles.length - 1].time } : { from: '', to: '' },
    totalRows: Math.max(0, rows.length - 1),
    validRows: candles.length,
    errors: [...parseResult.errors, ...validationResult.errors],
    warnings: [...parseResult.warnings, ...validationResult.warnings],
    candles,
  };
}

export function useImport() {
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);

  const importFile = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const result = await parseImportFile(file);
      setImportResult(result);
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  const importFiles = useCallback(async (files: File[]) => {
    setLoading(true);
    try {
      const results = await Promise.all(files.map(parseImportFile));
      setImportResult(results[results.length - 1] ?? null);
      return results;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearResult = useCallback(() => {
    setImportResult(null);
  }, []);

  return { importFile, importFiles, importResult, loading, clearResult };
}

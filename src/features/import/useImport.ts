import { useCallback, useState } from 'react';
import * as XLSX from 'xlsx';
import type { ImportResult } from '@/models';
import { parseSheetData } from './parser';
import { validateCandles } from './validator';

export function useImport() {
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);

  const importFile = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

      const parseResult = parseSheetData(rows);
      const validationResult = validateCandles(parseResult.candles);

      const allErrors = [...parseResult.errors, ...validationResult.errors];
      const allWarnings = [...parseResult.warnings, ...validationResult.warnings];

      const candles = validationResult.validCandles;

      // Determine symbol from first candle
      const symbol = candles.length > 0 ? candles[0].symbol : '';
      const dateRange = candles.length > 0
        ? { from: candles[0].time, to: candles[candles.length - 1].time }
        : { from: '', to: '' };

      const result: ImportResult = {
        success: allErrors.length === 0 && candles.length > 0,
        fileName: file.name,
        symbol,
        dateRange,
        totalRows: rows.length - 1, // exclude header
        validRows: candles.length,
        errors: allErrors,
        warnings: allWarnings,
        candles,
      };

      setImportResult(result);
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearResult = useCallback(() => {
    setImportResult(null);
  }, []);

  return { importFile, importResult, loading, clearResult };
}

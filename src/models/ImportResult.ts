import type { Candle } from './Candle';

export interface ImportWarning {
  row: number;
  message: string;
}

export interface ImportError {
  row: number;
  message: string;
}

export interface ImportResult {
  success: boolean;
  fileName: string;
  symbol: string;
  name?: string;
  dateRange: { from: string; to: string };
  totalRows: number;
  validRows: number;
  errors: ImportError[];
  warnings: ImportWarning[];
  candles: Candle[];
  instrumentId?: string;
  adjustmentMode?: 'none' | 'qfq' | 'hfq';
  factorVersion?: string | null;
  adjustmentQualityStatus?: 'pass' | 'warning';
  adjustmentWarnings?: Array<{
    ruleCode: string;
    details?: Record<string, unknown>;
  }>;
}

/**
 * Maps Excel column headers (Chinese-English mixed) to internal field names.
 * Each entry maps to a key in the Candle model and a list of possible header names.
 */
export interface FieldMapping {
  field: string;
  aliases: string[];
}

export const FIELD_MAPPINGS: FieldMapping[] = [
  { field: 'date', aliases: ['日期', '日期Date', 'date', 'Date'] },
  { field: 'symbol', aliases: ['指数代码', '指数代码Index Code', 'symbol', 'code'] },
  { field: 'open', aliases: ['开盘', '开盘Open', 'open', 'Open'] },
  { field: 'high', aliases: ['最高', '最高High', 'high', 'High'] },
  { field: 'low', aliases: ['最低', '最低Low', 'low', 'Low'] },
  { field: 'close', aliases: ['收盘', '收盘Close', 'close', 'Close'] },
  { field: 'change', aliases: ['涨跌', '涨跌Change', 'change', 'Change'] },
  { field: 'changePercent', aliases: ['涨跌幅(%)Change(%)', '涨跌幅(%)', '涨跌幅', 'changePercent'] },
  { field: 'volume', aliases: ['成交量 Volume', '成交量', 'volume', 'Volume'] },
  { field: 'turnover', aliases: ['成交金额（亿元）Turnover', '成交金额', '成交金额(亿元)', 'turnover', 'Turnover'] },
  { field: 'constituentCount', aliases: ['样本数量ConsNumber', '样本数量', 'constituentCount'] },
];

/**
 * Build a column index → field name map from a header row.
 * Returns null if required fields are missing.
 */
export function mapHeaders(headerRow: unknown[]): {
  mapping: Record<number, string>;
  missingFields: string[];
} {
  const mapping: Record<number, string> = {};
  const requiredFields = ['date', 'open', 'high', 'low', 'close'];
  const foundFields = new Set<string>();

  for (let i = 0; i < headerRow.length; i++) {
    const raw = String(headerRow[i] ?? '').trim();
    for (const fm of FIELD_MAPPINGS) {
      if (fm.aliases.some(a => raw === a || raw.includes(a))) {
        mapping[i] = fm.field;
        foundFields.add(fm.field);
        break;
      }
    }
  }

  const missingFields = requiredFields.filter(f => !foundFields.has(f));

  return { mapping, missingFields };
}

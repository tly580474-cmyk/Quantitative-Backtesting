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
  { field: 'symbol', aliases: ['指数代码', '指数代码Index Code', '代码', 'symbol', 'code'] },
  { field: 'open', aliases: ['开盘价', '开盘', '开盘Open', 'open', 'Open'] },
  { field: 'high', aliases: ['最高价', '最高', '最高High', 'high', 'High'] },
  { field: 'low', aliases: ['最低价', '最低', '最低Low', 'low', 'Low'] },
  { field: 'close', aliases: ['收盘价', '收盘', '收盘Close', 'close', 'Close'] },
  { field: 'change', aliases: ['涨跌', '涨跌Change', 'change', 'Change'] },
  { field: 'changePercent', aliases: ['涨跌幅(%)Change(%)', '涨跌幅(%)', '涨跌幅', '涨幅%', 'changePercent'] },
  { field: 'volume', aliases: ['成交量 Volume', '成交量', 'volume', 'Volume'] },
  { field: 'turnover', aliases: ['成交金额（亿元）Turnover', '成交金额', '成交金额(亿元)', '成交额（元）', '成交额', 'turnover', 'Turnover'] },
  { field: 'turnoverRatePct', aliases: ['换手率百分比', '换手率(%)', '换手率', 'turnoverRatePct'] },
  { field: 'constituentCount', aliases: ['样本数量ConsNumber', '样本数量', 'constituentCount'] },
];

/**
 * Build a column index → field name map from a header row.
 * Returns null if required fields are missing.
 */
export function mapHeaders(headerRow: unknown[]): {
  mapping: Record<number, string>;
  valueMultipliers: Record<number, number>;
  missingFields: string[];
} {
  const mapping: Record<number, string> = {};
  const valueMultipliers: Record<number, number> = {};
  const requiredFields = ['date', 'open', 'high', 'low', 'close'];
  const foundFields = new Set<string>();

  for (let i = 0; i < headerRow.length; i++) {
    const raw = String(headerRow[i] ?? '').trim();
    if (/^(?:前收盘|昨收)/.test(raw)) continue;
    const exactMatch = FIELD_MAPPINGS.find((fm) =>
      fm.aliases.some((alias) => raw === alias),
    );
    if (exactMatch) {
      mapping[i] = exactMatch.field;
      valueMultipliers[i] = getValueMultiplier(exactMatch.field, raw);
      foundFields.add(exactMatch.field);
      continue;
    }

    const partialMatches = FIELD_MAPPINGS.flatMap((fm) =>
      fm.aliases
        .filter((alias) => raw.includes(alias))
        .map((alias) => ({ field: fm.field, aliasLength: alias.length })),
    ).sort((a, b) => b.aliasLength - a.aliasLength);

    const bestMatch = partialMatches[0];
    if (bestMatch) {
      mapping[i] = bestMatch.field;
      valueMultipliers[i] = getValueMultiplier(bestMatch.field, raw);
      foundFields.add(bestMatch.field);
    }
  }

  const missingFields = requiredFields.filter(f => !foundFields.has(f));

  return { mapping, valueMultipliers, missingFields };
}

/**
 * Candle.turnover is stored in 亿元. Convert source columns whose header
 * explicitly declares 元 while keeping 亿元 and legacy unit-less headers as-is.
 */
function getValueMultiplier(field: string, header: string): number {
  if (field !== 'turnover') return 1;

  const normalizedHeader = header
    .replace(/[（【\[]/g, '(')
    .replace(/[）】\]]/g, ')')
    .replace(/\s/g, '')
    .toLowerCase();

  if (normalizedHeader.includes('亿元') || normalizedHeader.includes('(亿)')) {
    return 1;
  }

  if (normalizedHeader.includes('(元)')) {
    return 1 / 100_000_000;
  }

  return 1;
}

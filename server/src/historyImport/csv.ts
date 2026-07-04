export const HISTORY_COLUMNS = [
  '日期', '代码', '名称', '所属行业', '开盘价', '最高价', '最低价', '收盘价', '前收盘价',
  '成交量（股）', '成交额（元）', '换手率', '涨幅%', '振幅%', '是否ST', '量比',
  '3日涨幅%', '6日涨幅%', '10日涨幅%', '25日涨幅%', '是否涨停',
  '总股本（股）', '流通股本（股）', '总市值（元）', '流通市值（元）',
  '滚动市盈率', '市净率', '滚动市销率',
  '5日线', '10日线', '20日线', '30日线', '60日线', '120日线', '250日线',
  '上市时间', '退市时间',
] as const;

export type HistoryColumn = typeof HISTORY_COLUMNS[number];
export type HistoryRecord = Record<HistoryColumn, string>;

export interface NormalizedHistoryRow {
  tradeDate: string;
  code: string;
  name: string;
  industry: string | null;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose: number | null;
  volume: number | null;
  amount: number | null;
  turnoverRatePct: number | null;
  totalShares: number | null;
  floatShares: number | null;
  totalMarketCap: number | null;
  floatMarketCap: number | null;
  peTtm: number | null;
  pb: number | null;
  psTtm: number | null;
  volumeRatio: number | null;
  isSt: boolean;
  isLimitUp: boolean;
  listDate: string | null;
  delistDate: string | null;
}

const NULL_VALUES = new Set(['', '-', 'nan', 'none', 'null']);

export function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error('CSV 行包含未闭合的引号');
  values.push(value);
  if (values[0]?.charCodeAt(0) === 0xfeff) {
    values[0] = values[0].slice(1);
  }
  return values;
}

export function assertHistoryHeader(line: string): void {
  const actual = parseCsvLine(line);
  if (
    actual.length !== HISTORY_COLUMNS.length
    || actual.some((column, index) => column !== HISTORY_COLUMNS[index])
  ) {
    throw new Error(`历史行情表头不匹配：实际 ${actual.length} 列，预期 ${HISTORY_COLUMNS.length} 列`);
  }
}

export function parseHistoryRecord(line: string): HistoryRecord {
  const values = parseCsvLine(line);
  if (values.length !== HISTORY_COLUMNS.length) {
    throw new Error(`CSV 数据列数错误：实际 ${values.length} 列，预期 ${HISTORY_COLUMNS.length} 列`);
  }
  return Object.fromEntries(
    HISTORY_COLUMNS.map((column, index) => [column, values[index].trim()]),
  ) as HistoryRecord;
}

export function normalizeHistoryRecord(
  record: HistoryRecord,
  options: { allowInvalidOhlc?: boolean } = {},
): NormalizedHistoryRow {
  const tradeDate = normalizeDate(record['日期']);
  const code = record['代码'].padStart(6, '0');
  if (!/^\d{6}$/.test(code)) throw new Error(`证券代码无效：${record['代码']}`);

  const open = requiredNumber(record['开盘价'], '开盘价');
  const high = requiredNumber(record['最高价'], '最高价');
  const low = requiredNumber(record['最低价'], '最低价');
  const close = requiredNumber(record['收盘价'], '收盘价');
  if (!isValidOhlc({ open, high, low, close }) && !options.allowInvalidOhlc) {
    throw new Error(`${tradeDate} OHLC 关系无效`);
  }

  return {
    tradeDate,
    code,
    name: record['名称'] || code,
    industry: nullableText(record['所属行业']),
    open,
    high,
    low,
    close,
    previousClose: nullableNumber(record['前收盘价']),
    volume: nullableNonNegativeInteger(record['成交量（股）'], '成交量'),
    amount: nullableNumber(record['成交额（元）']),
    turnoverRatePct: nullableNumber(record['换手率']),
    totalShares: nullableNonNegativeInteger(record['总股本（股）'], '总股本'),
    floatShares: nullableNonNegativeInteger(record['流通股本（股）'], '流通股本'),
    totalMarketCap: nullableNumber(record['总市值（元）']),
    floatMarketCap: nullableNumber(record['流通市值（元）']),
    peTtm: nullableNumber(record['滚动市盈率']),
    pb: nullableNumber(record['市净率']),
    psTtm: nullableNumber(record['滚动市销率']),
    volumeRatio: nullableNumber(record['量比']),
    isSt: record['是否ST'] === '是' || record['名称'].toUpperCase().includes('ST'),
    isLimitUp: record['是否涨停'] === '是',
    listDate: nullableDate(record['上市时间']),
    delistDate: nullableDate(record['退市时间']),
  };
}

export function isValidOhlc(
  row: Pick<NormalizedHistoryRow, 'open' | 'high' | 'low' | 'close'>,
): boolean {
  return (
    row.low <= Math.min(row.open, row.close)
    && row.high >= Math.max(row.open, row.close)
    && row.low <= row.high
  );
}

export function inferMarket(code: string): 'SH' | 'SZ' | 'BJ' {
  if (code.startsWith('6')) return 'SH';
  if (code.startsWith('0') || code.startsWith('3')) return 'SZ';
  return 'BJ';
}

export function inferInstrumentStatus(
  name: string,
  delistDate: string | null,
  today = new Date().toISOString().slice(0, 10),
): 'active' | 'delisted' {
  return (
    name.includes('退市')
    || name.endsWith('退')
    || (delistDate !== null && delistDate <= today)
  ) ? 'delisted' : 'active';
}

function normalizeDate(value: string): string {
  const compact = value.trim();
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compact)) {
    throw new Error(`日期格式无效：${value}`);
  }
  const parsed = new Date(`${compact}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== compact) {
    throw new Error(`日期无效：${value}`);
  }
  return compact;
}

function nullableDate(value: string): string | null {
  return isNullValue(value) ? null : normalizeDate(value);
}

function nullableText(value: string): string | null {
  return isNullValue(value) ? null : value.trim();
}

function requiredNumber(value: string, label: string): number {
  const parsed = nullableNumber(value);
  if (parsed === null) throw new Error(`${label}不能为空`);
  return parsed;
}

function nullableNumber(value: string): number | null {
  if (isNullValue(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`数值无效：${value}`);
  return parsed;
}

function nullableNonNegativeInteger(value: string, label: string): number | null {
  const parsed = nullableNumber(value);
  if (parsed === null) return null;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}必须是非负安全整数：${value}`);
  }
  return parsed;
}

function isNullValue(value: string): boolean {
  return NULL_VALUES.has(value.trim().toLowerCase());
}

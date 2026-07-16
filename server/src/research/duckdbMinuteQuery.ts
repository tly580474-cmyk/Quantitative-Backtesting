import { join, resolve } from 'node:path';
import type { ParameterMap } from './duckdbCliSupport.js';

export interface MinuteQueryOptions {
  minuteRoot: string;
  symbols: string[];
  startDate?: string;
  endDate?: string;
  days?: string;
  interval?: string;
  includeAuction: boolean;
}

export interface MinuteQueryResult {
  sql: string;
  params: ParameterMap;
  symbols: string[];
  startDate: string;
  endDate: string;
  intervalMinutes: number;
  parquetPatterns: string[];
}

export function buildMinuteQuery(
  options: MinuteQueryOptions,
  now = new Date(),
): MinuteQueryResult {
  if (options.symbols.length === 0) throw new Error('minute 命令至少需要一个 --symbol');
  const symbols = [...new Set(options.symbols.map(normalizeMinuteSymbol))];
  const endDate = options.endDate ?? formatLocalDate(now);
  assertDate(endDate, 'end');
  const days = parseInteger(options.days, 'days', 1, 3660, 30);
  const startDate = options.startDate ?? addDays(endDate, -(days - 1));
  assertDate(startDate, 'start');
  if (startDate > endDate) throw new Error('start 不能晚于 end');
  const intervalMinutes = parseMinuteInterval(options.interval ?? '5m');
  const parquetPatterns = buildMonthPatterns(options.minuteRoot, startDate, endDate);
  const params: ParameterMap = { startDate, endDate };
  const codePlaceholders = symbols.map((symbol, index) => {
    const key = `code${index}`;
    params[key] = symbol;
    return `$${key}`;
  });
  const paths = parquetPatterns
    .map((path) => `'${escapeSqlLiteral(normalizeDuckDbPath(path))}'`)
    .join(',\n        ');
  const auctionFilter = options.includeAuction
    ? ''
    : "AND STRFTIME('%H:%M', CAST(trade_time AS TIMESTAMP)) <> '09:30'";

  return {
    params,
    symbols,
    startDate,
    endDate,
    intervalMinutes,
    parquetPatterns,
    sql: `
      WITH source_rows AS (
        SELECT code,
               CAST(trade_time AS TIMESTAMP) AS trade_time,
               open,
               high,
               low,
               close,
               vol,
               amount,
               CASE
                 WHEN CAST(trade_time AS TIME) <= TIME '11:30:00' THEN 'AM'
                 ELSE 'PM'
               END AS sessionName
        FROM read_parquet([
          ${paths}
        ])
        WHERE code IN (${codePlaceholders.join(', ')})
          AND CAST(trade_time AS TIMESTAMP) >= CAST($startDate AS DATE)
          AND CAST(trade_time AS TIMESTAMP) < CAST($endDate AS DATE) + INTERVAL 1 DAY
          AND (
            CAST(trade_time AS TIME) BETWEEN TIME '09:30:00' AND TIME '11:30:00'
            OR CAST(trade_time AS TIME) BETWEEN TIME '13:00:00' AND TIME '15:00:00'
          )
          ${auctionFilter}
      ),
      numbered AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY code, CAST(trade_time AS DATE), sessionName
                 ORDER BY trade_time
               ) - 1 AS minuteIndex
        FROM source_rows
      ),
      aggregated AS (
        SELECT code,
               CAST(trade_time AS DATE) AS tradeDate,
               sessionName,
               FLOOR(minuteIndex / ${intervalMinutes}) AS barIndex,
               MIN(trade_time) AS barStart,
               MAX(trade_time) AS barEnd,
               CAST(FIRST(open ORDER BY trade_time) AS DECIMAL(18, 6)) AS open,
               CAST(MAX(high) AS DECIMAL(18, 6)) AS high,
               CAST(MIN(low) AS DECIMAL(18, 6)) AS low,
               CAST(LAST(close ORDER BY trade_time) AS DECIMAL(18, 6)) AS close,
               SUM(vol) AS volume,
               CAST(SUM(amount) AS DECIMAL(24, 2)) AS amount,
               COUNT(*) AS sourceMinutes
        FROM numbered
        GROUP BY code, tradeDate, sessionName, barIndex
      )
      SELECT code,
             tradeDate,
             barStart,
             barEnd,
             open,
             high,
             low,
             close,
             volume,
             amount,
             sourceMinutes,
             sourceMinutes = ${intervalMinutes} AS completeBar
      FROM aggregated
      ORDER BY code, tradeDate, barStart
    `,
  };
}

export function normalizeMinuteSymbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) return normalized;
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error(`股票代码无效：${value}，应为 6 位代码或带 .SH/.SZ/.BJ 后缀`);
  }
  if (/^(5|6|9)/.test(normalized)) return `${normalized}.SH`;
  if (/^(0|1|2|3)/.test(normalized)) return `${normalized}.SZ`;
  if (/^(4|8)/.test(normalized)) return `${normalized}.BJ`;
  throw new Error(`无法判断股票代码市场：${value}，请显式提供交易所后缀`);
}

export function parseMinuteInterval(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+)(?:m|min)?$/);
  if (!match) throw new Error('interval 格式无效，例如 1m、5m、15m、30m、60m');
  const minutes = Number(match[1]);
  if (![1, 5, 10, 15, 30, 60, 120].includes(minutes)) {
    throw new Error('interval 仅支持 1m、5m、10m、15m、30m、60m、120m');
  }
  return minutes;
}

function buildMonthPatterns(rootInput: string, startDate: string, endDate: string): string[] {
  const root = resolve(rootInput);
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const patterns: string[] = [];
  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = String(cursor.getMonth() + 1).padStart(2, '0');
    patterns.push(join(root, `year=${year}`, `${year}${month}*.parquet`));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return patterns;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return formatLocalDate(value);
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00`))) {
    throw new Error(`${label} 日期格式无效，应为 YYYY-MM-DD`);
  }
}

function parseInteger(
  value: string | undefined,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的整数`);
  }
  return parsed;
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

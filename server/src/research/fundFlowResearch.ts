import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

export interface FundFlowOptions { end: string; days: number; top: number; group: 'stock' | 'industry'; symbol?: string; start?: string; }
export const FUND_FLOW_FIELDS = {
  tradeDate: '交易日 YYYY-MM-DD，最近N日按SH交易日历选择，缺数据不向更早日期补齐',
  mainNetInYi: '主力净流入，超大单+大单，单位亿元；负数为净流出',
  sampleCount: '实际有资金流记录的股票数量，不保证全市场覆盖',
  expectedCount: '同期本地日线的股票数量，仅作覆盖参照；停牌等原因可导致差异',
  referenceCountDifference: '同期日线参照数减资金流样本数；只是数量之差，不是逐股核实的缺失名单',
  rowsCount: '本次选定窗口的来源记录数，不是数据库历史总行数',
  latestFetchedAtUtc: '采集器按UTC写入fetched_at，显式Z后缀；北京时间见latestFetchedAtShanghai，不把UTC小时当作北京时间',
  daysCovered: '排名对象实际有数据的交易日数；不足请求窗口时为部分样本',
  industry: 'instruments.industry 当前来源行业；查询时映射，非历史时点行业或官方板块资金流',
};

export function validateFundFlowOptions(input: FundFlowOptions): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.end) || !Number.isFinite(Date.parse(input.end))
    || new Date(input.end).toISOString().slice(0, 10) !== input.end) throw new Error('INVALID_ARGUMENT: end 必须为有效 YYYY-MM-DD');
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 60) throw new Error('INVALID_ARGUMENT: days 必须为 1..60 个交易日');
  if (!Number.isInteger(input.top) || input.top < 1 || input.top > 50) throw new Error('INVALID_ARGUMENT: top 必须为 1..50');
  if (!['stock', 'industry'].includes(input.group)) throw new Error('INVALID_ARGUMENT: group 使用 stock 或 industry');
  if (input.symbol != null && !/^\d{6}$/.test(input.symbol)) throw new Error('INVALID_ARGUMENT: symbol 必须是6位股票代码');
  if (input.start && (!/^\d{4}-\d{2}-\d{2}$/.test(input.start) || !Number.isFinite(Date.parse(input.start))
    || new Date(input.start).toISOString().slice(0, 10) !== input.start || input.start > input.end)) throw new Error('INVALID_ARGUMENT: start 必须为不晚于 end 的有效日期');
}

export function buildFundFlowResult(input: FundFlowOptions, dates: string[], dailyRows: RowDataPacket[],
  expectedRows: RowDataPacket[], rankings: RowDataPacket[], sources: RowDataPacket[], capturedAt: string) {
  const expected = new Map(expectedRows.map(row => [String(row.tradeDate), Number(row.expectedCount)]));
  const actual = new Map(dailyRows.map(row => [String(row.tradeDate), row]));
  const daily = dates.map(tradeDate => {
    const row = actual.get(tradeDate);
    const sampleCount = Number(row?.sampleCount ?? 0);
    const expectedCount = expected.get(tradeDate) ?? null;
    return { tradeDate, sampleCount, expectedCount,
      referenceCountDifference: expectedCount == null ? null : expectedCount - sampleCount,
      coverageRatio: expectedCount ? sampleCount / expectedCount : null,
      mainNetInYi: row ? Number(row.mainNetInYi) : null,
      superLargeNetInYi: row ? Number(row.superLargeNetInYi) : null,
      largeNetInYi: row ? Number(row.largeNetInYi) : null,
      nonFinalCount: Number(row?.nonFinalCount ?? 0),
    };
  });
  const missingDates = daily.filter(row => row.sampleCount === 0).map(row => row.tradeDate);
  const known = daily.filter(row => row.mainNetInYi != null);
  const sorted = rankings.map(row => ({
    symbol: row.symbol == null ? undefined : String(row.symbol),
    market: row.market == null ? undefined : String(row.market),
    name: row.name == null ? undefined : String(row.name),
    industry: row.industry == null ? undefined : String(row.industry),
    mainNetInYi: Number(row.mainNetInYi), daysCovered: Number(row.daysCovered), sampleCount: Number(row.sampleCount),
  })).sort((a, b) => b.mainNetInYi - a.mainNetInYi || String(a.symbol ?? a.industry).localeCompare(String(b.symbol ?? b.industry)));
  const partial = (!input.start && dates.length < input.days) || missingDates.length > 0 || daily.some(row => row.nonFinalCount > 0);
  return {
    kind: 'research-data', ok: true, usable: known.length > 0, dataset: 'fund_flows',
    status: !known.length ? 'no-data' : partial ? 'partial' : 'available',
    retrievedAt: capturedAt, requested: { ...input, ...(input.start ? { days: undefined } : {}) }, unit: '亿元', fields: FUND_FLOW_FIELDS,
    source: { table: 'stock_fund_flows', scope: '本地落库A股（SH/SZ/BJ stock）；只读，不触发上游更新', providers: sources },
    dates, missingDates, calendarDaysFound: dates.length, windowComplete: !partial,
    coverageNote: 'available仅表示选定交易日有记录；逐日样本数、覆盖率、非最终记录及排名对象daysCovered需单独检查。样本差异的原因尚未逐股核实，不得归因为停牌或来源遗漏。',
    classification: input.group === 'industry' ? {
      basis: 'current_instrument_industry', asOf: capturedAt,
      note: '按查询时instruments.industry聚合；不是历史时点分类，也不是供应商行业板块资金流接口。',
    } : null,
    daily,
    dailyDirection: {
      inflowDays: known.filter(row => row.mainNetInYi! > 0).length,
      outflowDays: known.filter(row => row.mainNetInYi! < 0).length,
      flatDays: known.filter(row => row.mainNetInYi === 0).length,
      inflowTotalYi: known.filter(row => row.mainNetInYi! > 0).reduce((sum, row) => sum + row.mainNetInYi!, 0),
      outflowTotalYi: known.filter(row => row.mainNetInYi! < 0).reduce((sum, row) => sum + row.mainNetInYi!, 0),
      note: '仅统计已取得净额的日期，缺失日期不计为零；此处为整个样本的逐日方向，不是逐股票方向。',
    },
    totalMainNetInYi: known.length ? known.reduce((sum, row) => sum + row.mainNetInYi!, 0) : null,
    totalMeaning: partial ? '仅已取得日期的部分合计，不代表完整请求窗口' : '所列样本及日期的主力净流入合计',
    topInflow: sorted.filter(row => row.mainNetInYi > 0).slice(0, input.top),
    topOutflow: sorted.filter(row => row.mainNetInYi < 0).reverse().slice(0, input.top),
  };
}

/** Parameterized SELECTs inside a read-only consistent transaction; never updates the market store. */
export async function queryFundFlows(pool: Pool, input: FundFlowOptions) {
  validateFundFlowOptions(input);
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const dates = (await rows(connection,
      `SELECT DISTINCT trade_date AS tradeDate FROM trading_calendar
       WHERE market='SH' AND is_open=1 AND trade_date<=? ${input.start ? 'AND trade_date>=?' : ''}
       ORDER BY trade_date DESC LIMIT ?`, [input.end, ...(input.start ? [input.start] : []), input.start ? 61 : input.days]))
      .map(row => String(row.tradeDate)).reverse();
    if (input.start && dates.length > 60) throw new Error('INVALID_ARGUMENT: 资金流 coverage 范围最多60个交易日，请缩小 start/end');
    if (!dates.length) return buildFundFlowResult(input, [], [], [], [], [], new Date().toISOString());
    const marks = dates.map(() => '?').join(',');
    const filter = `i.type='stock' AND i.market IN ('SH','SZ','BJ')${input.symbol ? ' AND i.symbol=?' : ''}`;
    const params = [...dates, ...(input.symbol ? [input.symbol] : [])];
    // Bound work by the requested dates. The production optimizer otherwise chooses
    // instruments first and scans every instrument's multi-year primary-key history.
    const from = `FROM stock_fund_flows f FORCE INDEX (idx_sff_trade_date_instrument)
      STRAIGHT_JOIN instruments i ON i.instrument_key=f.instrument_key
      WHERE f.trade_date IN (${marks}) AND ${filter}`;
    const daily = await rows(connection, `SELECT /*+ MAX_EXECUTION_TIME(30000) */
      DATE_FORMAT(f.trade_date,'%Y-%m-%d') tradeDate, COUNT(*) sampleCount,
      SUM(f.main_net_in)/100000000 mainNetInYi, SUM(f.super_large_net_in)/100000000 superLargeNetInYi,
      SUM(f.large_net_in)/100000000 largeNetInYi, SUM(f.is_final<>1) nonFinalCount ${from} GROUP BY f.trade_date`, params);
    const expected = await rows(connection, `SELECT /*+ MAX_EXECUTION_TIME(30000) */
      DATE_FORMAT(b.trade_date,'%Y-%m-%d') tradeDate, COUNT(*) expectedCount
      FROM daily_bars_v2 b FORCE INDEX (idx_dbv2_trade_date_instrument)
      STRAIGHT_JOIN instruments i ON i.instrument_key=b.instrument_key
      WHERE b.trade_date IN (${marks}) AND ${filter} GROUP BY b.trade_date`, params);
    const identity = input.group === 'industry' ? `COALESCE(NULLIF(i.industry,''),'未分类') industry`
      : 'i.market market,i.symbol symbol,i.name name';
    const group = input.group === 'industry' ? `COALESCE(NULLIF(i.industry,''),'未分类')` : 'i.market,i.symbol,i.name';
    const rankings = await rows(connection, `SELECT /*+ MAX_EXECUTION_TIME(30000) */ ${identity},
      SUM(f.main_net_in)/100000000 mainNetInYi, COUNT(DISTINCT f.trade_date) daysCovered,
      COUNT(DISTINCT f.instrument_key) sampleCount ${from} GROUP BY ${group}`, params);
    const sources = await rows(connection, `SELECT f.source_key sourceKey, f.source_version sourceVersion,
      COUNT(*) rowsCount, DATE_FORMAT(MAX(f.fetched_at),'%Y-%m-%dT%H:%i:%sZ') latestFetchedAtUtc,
      DATE_FORMAT(DATE_ADD(MAX(f.fetched_at), INTERVAL 8 HOUR),'%Y-%m-%dT%H:%i:%s+08:00') latestFetchedAtShanghai
      ${from} GROUP BY f.source_key,f.source_version`, params);
    return buildFundFlowResult(input, dates, daily, expected, rankings, sources, new Date().toISOString());
  } finally {
    try { await connection.rollback(); } finally { connection.release(); }
  }
}

async function rows(connection: PoolConnection, sql: string, params: unknown[]) {
  const [result] = await connection.query<RowDataPacket[]>(sql, params);
  return result;
}

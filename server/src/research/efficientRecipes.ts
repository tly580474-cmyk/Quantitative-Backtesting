export const EFFICIENT_RECIPES = {
  'candidate-screen': '前复权20交易日动量、完整交易日窗口、非ST沪深A股、20日平均成交额筛选',
  'factor-layer-14': '同一20日动量因子五分层，信号次日开盘入场、第14交易日收盘退出；缺失退出单独统计',
  'pe-dca': '用户提供已核验官方指数PE及价格序列；历史滚动分位、次日执行、月度定投与固定金额对照',
};
export function efficientRecipeSql(name: string, flags: Map<string, string>) {
  if (!['candidate-screen', 'factor-layer-14'].includes(name)) throw new Error('INVALID_ARGUMENT: 未知SQL配方');
  const end = flags.get('--end');
  const start = flags.get('--start') ?? end;
  for (const date of [start, end]) if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('INVALID_ARGUMENT: 配方要求有效 --end，可附 --start');
  if (start! > end!) throw new Error('INVALID_ARGUMENT: start > end');
  const top = Number(flags.get('--top') ?? 20);
  const amount = Number(flags.get('--min-amount') ?? 100_000_000);
  if (!Number.isInteger(top) || top < 1 || top > 100 || !Number.isFinite(amount) || amount < 0) throw new Error('INVALID_ARGUMENT: top 1..100，min-amount >= 0');
  const params = { start: start!, end: end!, top, amount };
  const ctes = `WITH calendar AS (
    SELECT tradeDate, ROW_NUMBER() OVER(ORDER BY tradeDate) AS day FROM trading_calendar WHERE tradeDate <= $end
  ), adjustments AS (
    SELECT * FROM adjustment_factors
    QUALIFY ROW_NUMBER() OVER(PARTITION BY instrumentKey,effectiveDate ORDER BY publishedAt DESC, factorVersion DESC) = 1
  ), prices AS (
    SELECT b.instrumentKey,b.symbol,b.name,b.market,b.tradeDate,c.day,b.amount,
      b.open*a.factor+a.priceOffset AS adjOpen,b.close*a.factor+a.priceOffset AS adjClose
    FROM bars b JOIN calendar c ON b.tradeDate=c.tradeDate
    ASOF LEFT JOIN adjustments a ON b.instrumentKey=a.instrumentKey AND b.tradeDate>=a.effectiveDate
    WHERE b.tradeDate BETWEEN CAST($start AS DATE)-INTERVAL 90 DAY AND CAST($end AS DATE)
      AND ((b.market='SH' AND (b.symbol LIKE '60%' OR b.symbol LIKE '68%')) OR (b.market='SZ' AND (b.symbol LIKE '00%' OR b.symbol LIKE '30%')))
  ), features AS (
    SELECT *, adjClose/NULLIF(LAG(adjClose,20) OVER w,0)-1 AS momentum20,
      day-LAG(day,20) OVER w AS calendarSpan,
      COUNT(adjClose) OVER(PARTITION BY instrumentKey ORDER BY day ROWS BETWEEN 20 PRECEDING AND CURRENT ROW) AS validCloses,
      AVG(amount) OVER(PARTITION BY instrumentKey ORDER BY day ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS meanAmount20,
      COUNT(amount) OVER(PARTITION BY instrumentKey ORDER BY day ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS amountDays
    FROM prices WINDOW w AS(PARTITION BY instrumentKey ORDER BY day)
  ), eligible AS (
    SELECT * FROM features WHERE calendarSpan=20 AND validCloses=21 AND amountDays=20
      AND adjClose>0 AND isfinite(momentum20) AND meanAmount20 >= $amount AND name NOT LIKE '%ST%'
      AND tradeDate BETWEEN $start AND $end
  )`;
  const sql = name === 'candidate-screen' ? `${ctes}
    SELECT tradeDate,symbol,name,adjClose,momentum20,meanAmount20,COUNT(*) OVER() AS eligibleCount
    FROM eligible WHERE tradeDate=$end ORDER BY momentum20 DESC,symbol LIMIT $top`
    : `${ctes}, ranked AS (
      SELECT *,NTILE(5) OVER(PARTITION BY tradeDate ORDER BY momentum20,symbol) AS layer FROM eligible
    ), outcomes AS (
      SELECT r.*,CASE WHEN e.adjOpen>0 AND x.adjClose>0 THEN x.adjClose/e.adjOpen-1 END AS futureReturn
      FROM ranked r LEFT JOIN prices e ON e.instrumentKey=r.instrumentKey AND e.day=r.day+1
      LEFT JOIN prices x ON x.instrumentKey=r.instrumentKey AND x.day=r.day+14
    ) SELECT layer,COUNT(*) AS signals,COUNT(futureReturn) AS samples,COUNT(*)-COUNT(futureReturn) AS missingExits,
      COUNT(*) FILTER(WHERE day+14>(SELECT MAX(day) FROM calendar)) AS immatureSignals,
      COUNT(*) FILTER(WHERE day+14<=(SELECT MAX(day) FROM calendar) AND futureReturn IS NULL) AS missingMaturedExits,
      MAX(tradeDate) FILTER(WHERE day+14<=(SELECT MAX(day) FROM calendar)) AS latestMatureSignalDate,
      COUNT(DISTINCT tradeDate) AS signalDates,AVG(futureReturn) AS averageReturn,
      MEDIAN(futureReturn) AS medianReturn,STDDEV_SAMP(futureReturn) AS returnVolatility,
      AVG(CASE WHEN futureReturn IS NOT NULL THEN CASE WHEN futureReturn>0 THEN 1.0 ELSE 0.0 END END) AS winRate
      FROM outcomes GROUP BY layer ORDER BY layer`;
  return { sql, params, semantics: {
    version: 1, price: 'raw * asof factor + priceOffset；缺失复权因子排除，不默认为1',
    factor: '20个交易日收盘动量；21个完整收盘，20个有效成交额；金额元',
    universe: '沪深60/68/00/30开头，当前名称排除ST；不是历史PIT证券池，可能有幸存者偏差',
    execution: name === 'candidate-screen' ? '截止日截面；不替换缺失截止日' : '信号当日分层，随后才连接未来价格；次日开盘入，第14交易日收盘出；缺失退出不补零',
    limitations: '重叠持有期样本非独立；未模拟涨跌停/停牌可成交性、手续费和滑点；复权为当前快照版本，非历史发布时点版本。不是可直接实盘收益。未到期与到期缺价分别统计；不能因层间缺失比例相近就认定没有选择偏差，成熟信号末日以latestMatureSignalDate为准。',
  } };
}

export function peDca(input: any, window = 252) {
  if (!input || input.source?.valuationType !== 'official-index-pe' || input.source?.availability !== 'point-in-time'
    || input.source?.priceBasis !== 'official-price-index' || !input.source?.name || !input.source?.instrument
    || !Array.isArray(input.rows) || !Array.isArray(input.tradingDates)) throw new Error('DATA_UNAVAILABLE: 需要可核验官方指数PE来源、PIT声明、价格指数口径及完整tradingDates；禁止个股PE静默代替');
  if (!Number.isInteger(window) || window < 2 || window > 2520 || input.rows.length > 30000) throw new Error('INVALID_ARGUMENT: window 2..2520，最多30000行');
  const rows: Array<{date: string; pe: number | null; close: number}> = input.rows;
  if (rows.length !== input.tradingDates.length || rows.some((r, i) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)
    || !Number.isFinite(Date.parse(r.date)) || new Date(r.date).toISOString().slice(0,10) !== r.date
    || r.date !== input.tradingDates[i] || (i > 0 && rows[i-1].date >= r.date)
    || typeof r.close !== 'number' || !Number.isFinite(r.close) || r.close <= 0
    || (r.pe !== null && (typeof r.pe !== 'number' || !Number.isFinite(r.pe) || r.pe <= 0)))) throw new Error('INVALID_ARGUMENT: 日期须唯一有序且匹配完整交易日历，价格为正，PE缺失用null');
  let units = 0, fixedUnits = 0, invested = 0, fixedInvested = 0, missedSignals = 0;
  const series: Array<Record<string, unknown>> = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date.slice(0,7) === rows[i-1].date.slice(0,7)) continue;
    const history = rows.slice(Math.max(0, i-window), i).map(r => r.pe);
    const signal = rows[i-1].pe;
    if (history.length !== window || history.some(v => v === null) || signal === null) { missedSignals++; continue; }
    const percentile = history.filter(v => v! <= signal).length / window;
    const contribution = 1000 * (percentile <= .2 ? 2 : percentile >= .8 ? .5 : 1);
    invested += contribution; fixedInvested += 1000;
    units += contribution / rows[i].close; fixedUnits += 1000 / rows[i].close;
    series.push({ date: rows[i].date, signalDate: rows[i-1].date, percentile, contribution,
      invested, value: units*rows[i].close, fixedInvested, fixedValue: fixedUnits*rows[i].close });
  }
  const close = rows.at(-1)?.close ?? 0;
  return { kind: 'research-data', ok: true, usable: series.length > 0, source: input.source, window,
    rowCount: series.length, missedSignals, invested, value: units*close, profit: units*close-invested,
    fixedInvested, fixedValue: fixedUnits*close, fixedProfit: fixedUnits*close-fixedInvested,
    end: rows.at(-1)?.date ?? null, series,
    semantics: '每月首个交易日以昨收可知PE在过去window日(含昨收)的<=分位决策，今日收盘按1000×低20%两倍/高80%半倍/中间一倍投入，允许碎股。基准在相同有效日期投1000；缺PE或预热不足时两组都跳过。无费用/分红，不是年化或时间加权收益。来源及日历为输入方声明，须外部核验。' };
}

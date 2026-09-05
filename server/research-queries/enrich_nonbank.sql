-- 2026-08-31 中证1000低PB top200 剔除银行后：因子富集（数据截至快照最新日 2026-09-04）
WITH
constituent_snapshots AS (
  SELECT * FROM index_constituent_snapshots WHERE indexCode = '000852'
),
rebalance_snapshots AS (
  SELECT s.snapshotId, s.constituentDate,
         row_number() OVER (ORDER BY s.constituentDate DESC, (s.weightDate IS NOT NULL) DESC, s.fetchedAt DESC) AS rn
  FROM constituent_snapshots s
  WHERE s.constituentDate <= DATE '2026-08-31'
  QUALIFY rn = 1
),
lifecycle AS (
  SELECT instrumentKey, min(tradeDate) AS firstDate FROM bars GROUP BY instrumentKey
),
candidates AS (
  SELECT b.instrumentKey, b.market, b.symbol, b.name, b.industry, b.pb AS pb_sel, b.totalMarketCap,
         b.close AS px_sel, l.firstDate
  FROM rebalance_snapshots rs
  JOIN index_constituents c ON c.snapshotId = rs.snapshotId
  JOIN bars b ON b.tradeDate = DATE '2026-08-31' AND b.symbol = c.constituentCode
  JOIN lifecycle l ON l.instrumentKey = b.instrumentKey
  WHERE b.market IN ('SH','SZ')
    AND b.pb IS NOT NULL AND b.pb > 0
    AND b.totalMarketCap IS NOT NULL AND b.totalMarketCap > 0
    AND b.close IS NOT NULL AND b.close > 0
    AND coalesce(b.volume,0) > 0
    AND upper(coalesce(b.name,'')) NOT LIKE '%ST%'
    AND coalesce(b.name,'') NOT LIKE '%退%'
    AND date_diff('day', l.firstDate, DATE '2026-08-31') >= 180
    AND trim(b.industry) <> '银行'
),
top200 AS (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (ORDER BY pb_sel, symbol) AS rank
    FROM candidates
  ) WHERE rank <= 200
),
adj AS (
  SELECT b.symbol, b.tradeDate, b.close,
         b.close * coalesce(f.factor,1) + coalesce(f.priceOffset,0) AS adjClose,
         b.amount, b.pb, b.totalMarketCap, b.turnoverRatePct
  FROM bars b
  ASOF LEFT JOIN adjustment_factors f ON b.instrumentKey = f.instrumentKey AND b.tradeDate >= f.effectiveDate
  WHERE b.symbol IN (SELECT symbol FROM top200)
    AND b.tradeDate >= DATE '2025-06-01'
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY symbol ORDER BY tradeDate DESC) AS rn
  FROM adj
),
snap AS (
  SELECT symbol,
         max(tradeDate) AS lastDate,
         max(adjClose) FILTER (WHERE rn = 1) AS px_last,
         max(adjClose) FILTER (WHERE rn = 21) AS px_20,
         max(adjClose) FILTER (WHERE rn = 61) AS px_60,
         max(adjClose) FILTER (WHERE rn = 121) AS px_120,
         max(adjClose) FILTER (WHERE rn = 251) AS px_250,
         max(adjClose) FILTER (WHERE rn <= 251) AS hi_52w,
         min(adjClose) FILTER (WHERE rn <= 251) AS lo_52w,
         avg(adjClose) FILTER (WHERE rn <= 60) AS ma60,
         avg(adjClose) FILTER (WHERE rn <= 20) AS ma20,
         avg(amount) FILTER (WHERE rn <= 20) AS amt20,
         max(totalMarketCap) FILTER (WHERE rn = 1) AS mcap_now,
         max(pb) FILTER (WHERE rn = 1) AS pb_now
  FROM ranked
  GROUP BY symbol
),
latest_fin AS (
  SELECT * FROM (
    SELECT symbol, reportPeriod, fiscalYear, fiscalQuarter, revenue, netProfitParent,
           revenueYoyPct, netProfitYoyPct, roePct, roeWeightedPct, grossMarginPct,
           netMarginPct, debtToAssetsPct,
           row_number() OVER (PARTITION BY symbol ORDER BY reportPeriod DESC, announcementDate DESC, fetchedAt DESC) AS rn
    FROM financial_reports
    WHERE announcementDate <= DATE '2026-08-31' AND netProfitParent IS NOT NULL
  ) WHERE rn = 1
),
div AS (
  SELECT symbol, sum(cashDividendPerShare) AS cash12m, count(*) AS divCount
  FROM dividend_events
  WHERE exDate BETWEEN DATE '2025-09-01' AND DATE '2026-08-31'
    AND cashDividendPerShare IS NOT NULL AND cashDividendPerShare > 0
    AND planStatus NOT IN ('不实施','不分配','预案作废')
  GROUP BY symbol
)
SELECT
  t.rank, t.symbol AS code, t.name, t.industry, t.pb_sel,
  round(s.pb_now, 3) AS pb_now,
  round(s.mcap_now / 1e8, 1) AS mcap_yi,
  round((s.px_last / NULLIF(t.px_sel, 0) - 1) * 100, 2) AS ret_sel_pct,
  round((s.px_last / NULLIF(s.px_20, 0) - 1) * 100, 2) AS mom20_pct,
  round((s.px_last / NULLIF(s.px_60, 0) - 1) * 100, 2) AS mom60_pct,
  round((s.px_last / NULLIF(s.px_120, 0) - 1) * 100, 2) AS mom120_pct,
  round((s.px_last / NULLIF(s.ma60, 0) - 1) * 100, 2) AS px_vs_ma60_pct,
  round((s.px_last / NULLIF(s.ma20, 0) - 1) * 100, 2) AS px_vs_ma20_pct,
  round((s.px_last / NULLIF(s.hi_52w, 0) - 1) * 100, 2) AS dist_hi52w_pct,
  round((s.px_last / NULLIF(s.lo_52w, 0) - 1) * 100, 2) AS dist_lo52w_pct,
  round(s.amt20 / 1e8, 2) AS avg_amt20d_yi,
  cast(f.reportPeriod AS VARCHAR) AS fin_period,
  f.fiscalQuarter AS fin_quarter,
  round(f.netProfitYoyPct, 1) AS netprofit_yoy_pct,
  round(f.revenueYoyPct, 1) AS revenue_yoy_pct,
  round(f.roeWeightedPct, 2) AS roe_pct,
  round(f.netMarginPct, 2) AS netmargin_pct,
  round(f.debtToAssetsPct, 1) AS debt_assets_pct,
  round(f.netProfitParent / 1e8, 2) AS netprofit_yi,
  round(d.cash12m / NULLIF(s.px_last, 0) * 100, 2) AS div_yield_pct,
  coalesce(d.divCount, 0) AS div_count
FROM top200 t
LEFT JOIN snap s USING (symbol)
LEFT JOIN latest_fin f USING (symbol)
LEFT JOIN div d USING (symbol)
ORDER BY t.rank;

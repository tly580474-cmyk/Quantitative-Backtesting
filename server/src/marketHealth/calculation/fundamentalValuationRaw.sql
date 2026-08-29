CREATE OR REPLACE TEMP TABLE market_health_daily_raw AS
WITH selected_dates AS (
  SELECT tradeDate
  FROM (
    SELECT DISTINCT tradeDate
    FROM read_parquet('__BARS_PATH__', hive_partitioning = true)
  )
  ORDER BY tradeDate DESC
  LIMIT __DATE_LIMIT__
), cutoff AS (
  SELECT MIN(tradeDate) AS min_date FROM selected_dates
), stock_history AS (
  SELECT
    instrumentKey, market, tradeDate, amount, totalMarketCap, peTtm, pb,
    ROW_NUMBER() OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS history_count
  FROM read_parquet('__BARS_PATH__', hive_partitioning = true)
  WHERE market IN ('SH', 'SZ', 'BJ') AND close > 0
), financial_versions AS (
  SELECT
    instrumentKey, reportPeriod, announcementDate, fiscalQuarter,
    COALESCE(netProfitParent, netProfit) AS attributable_profit,
    COALESCE(equityParent, totalEquity) AS attributable_equity,
    COALESCE(totalRevenue, revenue) AS report_revenue,
    fetchedAt, sourceFingerprint
  FROM read_parquet('__FINANCIAL_PATH__')
  WHERE announcementDate IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY instrumentKey, reportPeriod, announcementDate
    ORDER BY fetchedAt DESC, sourceFingerprint DESC
  ) = 1
), financial_comparables AS (
  SELECT
    current_report.*,
    prior_report.attributable_profit AS prior_year_profit,
    prior_report.attributable_equity AS prior_year_equity,
    prior_report.report_revenue AS prior_year_revenue,
    CASE WHEN current_report.attributable_equity > 0
      THEN 100.0 * current_report.attributable_profit
        * (4.0 / NULLIF(current_report.fiscalQuarter, 0))
        / current_report.attributable_equity END AS annualized_roe,
    CASE WHEN prior_report.attributable_equity > 0
      THEN 100.0 * prior_report.attributable_profit
        * (4.0 / NULLIF(prior_report.fiscalQuarter, 0))
        / prior_report.attributable_equity END AS prior_year_annualized_roe
  FROM financial_versions AS current_report
  LEFT JOIN financial_versions AS prior_report
    ON current_report.instrumentKey = prior_report.instrumentKey
   AND prior_report.reportPeriod = current_report.reportPeriod - INTERVAL 1 YEAR
   AND prior_report.announcementDate <= current_report.announcementDate
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY current_report.instrumentKey, current_report.reportPeriod,
                 current_report.announcementDate
    ORDER BY prior_report.announcementDate DESC NULLS LAST,
             prior_report.fetchedAt DESC NULLS LAST
  ) = 1
), financial_events AS (
  SELECT *
  FROM financial_comparables
  WHERE attributable_profit IS NOT NULL
    AND attributable_equity > 0
    AND prior_year_profit IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY instrumentKey, announcementDate
    ORDER BY reportPeriod DESC, fetchedAt DESC
  ) = 1
), daily_stock AS (
  SELECT
    market.tradeDate, market.instrumentKey, market.totalMarketCap, market.peTtm, market.pb,
    financial.reportPeriod, financial.announcementDate, financial.attributable_profit,
    financial.attributable_equity, financial.report_revenue, financial.prior_year_profit,
    financial.prior_year_revenue, financial.fiscalQuarter, financial.annualized_roe,
    financial.prior_year_annualized_roe
  FROM stock_history AS market
  ASOF LEFT JOIN financial_events AS financial
    ON market.instrumentKey = financial.instrumentKey
   AND market.tradeDate >= financial.announcementDate
  WHERE market.tradeDate >= (SELECT min_date FROM cutoff)
    AND market.history_count >= 120
    AND market.amount > 0
)
SELECT
  tradeDate,
  COUNT(*) AS eligible_stocks,
  100.0 * COUNT(annualized_roe) / COUNT(*) AS roe_coverage_pct,
  100.0 * COUNT(prior_year_profit) / COUNT(*) AS growth_coverage_pct,
  100.0 * COUNT(CASE WHEN peTtm > 0 THEN 1 END) / COUNT(*) AS pe_coverage_pct,
  100.0 * COUNT(CASE WHEN pb > 0 THEN 1 END) / COUNT(*) AS pb_coverage_pct,
  MAX(reportPeriod) AS latest_report_period,
  MAX(announcementDate) AS latest_announcement_date,
  100.0 * SUM(CASE WHEN attributable_equity > 0
    THEN attributable_profit * (4.0 / NULLIF(fiscalQuarter, 0)) ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN attributable_equity > 0 THEN attributable_equity ELSE 0.0 END), 0)
    AS aggregate_roe,
  100.0 * AVG(CASE WHEN annualized_roe IS NOT NULL AND annualized_roe > 0 THEN 1.0
                   WHEN annualized_roe IS NOT NULL THEN 0.0 END) AS positive_roe_breadth,
  100.0 * AVG(CASE
    WHEN annualized_roe IS NOT NULL AND prior_year_annualized_roe IS NOT NULL
      AND annualized_roe > prior_year_annualized_roe THEN 1.0
    WHEN annualized_roe IS NOT NULL AND prior_year_annualized_roe IS NOT NULL THEN 0.0 END)
    AS improving_roe_breadth,
  SUM(CASE WHEN prior_year_profit IS NOT NULL THEN attributable_profit ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN prior_year_profit IS NOT NULL THEN prior_year_profit ELSE 0.0 END), 0)
    - 1.0 AS aggregate_profit_growth,
  100.0 * AVG(CASE WHEN prior_year_profit IS NOT NULL AND attributable_profit > prior_year_profit THEN 1.0
                   WHEN prior_year_profit IS NOT NULL THEN 0.0 END) AS improving_profit_breadth,
  100.0 * AVG(CASE WHEN prior_year_revenue IS NOT NULL AND report_revenue > prior_year_revenue THEN 1.0
                   WHEN prior_year_revenue IS NOT NULL THEN 0.0 END) AS improving_revenue_breadth,
  SUM(CASE WHEN peTtm > 0 AND totalMarketCap > 0 THEN totalMarketCap ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN peTtm > 0 AND totalMarketCap > 0 THEN totalMarketCap / peTtm ELSE 0.0 END), 0)
    AS aggregate_pe,
  SUM(CASE WHEN pb > 0 AND totalMarketCap > 0 THEN totalMarketCap ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN pb > 0 AND totalMarketCap > 0 THEN totalMarketCap / pb ELSE 0.0 END), 0)
    AS aggregate_pb
FROM daily_stock
GROUP BY tradeDate;

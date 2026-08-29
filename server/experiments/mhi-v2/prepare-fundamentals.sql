-- Fundamental increment for MHI v2.
-- Financial facts become usable only on their announcement date; later corrections keep their own date.

CREATE OR REPLACE TEMP TABLE mhi_v2_financial_versions AS
SELECT
  instrumentKey,
  reportPeriod,
  announcementDate,
  fiscalYear,
  fiscalQuarter,
  COALESCE(netProfitParent, netProfit) AS attributable_profit,
  COALESCE(equityParent, totalEquity) AS attributable_equity,
  COALESCE(totalRevenue, revenue) AS report_revenue,
  netOperatingCashFlow,
  sourceVersion,
  sourceFingerprint,
  fetchedAt
FROM financial_reports
WHERE announcementDate IS NOT NULL
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY instrumentKey, reportPeriod, announcementDate
  ORDER BY fetchedAt DESC, sourceFingerprint DESC
) = 1;

CREATE OR REPLACE TEMP TABLE mhi_v2_financial_comparables AS
SELECT
  current_report.*,
  prior_report.attributable_profit AS prior_year_profit,
  prior_report.attributable_equity AS prior_year_equity,
  prior_report.report_revenue AS prior_year_revenue,
  prior_report.announcementDate AS prior_year_announcement_date,
  CASE
    WHEN current_report.attributable_equity > 0
      THEN 100.0 * current_report.attributable_profit
        * (4.0 / NULLIF(current_report.fiscalQuarter, 0))
        / current_report.attributable_equity
    ELSE NULL
  END AS annualized_roe,
  CASE
    WHEN prior_report.attributable_equity > 0
      THEN 100.0 * prior_report.attributable_profit
        * (4.0 / NULLIF(prior_report.fiscalQuarter, 0))
        / prior_report.attributable_equity
    ELSE NULL
  END AS prior_year_annualized_roe,
  CASE
    WHEN prior_report.attributable_profit IS NOT NULL
      THEN current_report.attributable_profit - prior_report.attributable_profit
    ELSE NULL
  END AS profit_change_yoy,
  CASE
    WHEN prior_report.report_revenue IS NOT NULL
      THEN current_report.report_revenue - prior_report.report_revenue
    ELSE NULL
  END AS revenue_change_yoy
FROM mhi_v2_financial_versions AS current_report
LEFT JOIN mhi_v2_financial_versions AS prior_report
  ON current_report.instrumentKey = prior_report.instrumentKey
 AND prior_report.reportPeriod = current_report.reportPeriod - INTERVAL 1 YEAR
 AND prior_report.announcementDate <= current_report.announcementDate
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY current_report.instrumentKey, current_report.reportPeriod,
               current_report.announcementDate
  ORDER BY prior_report.announcementDate DESC NULLS LAST, prior_report.fetchedAt DESC NULLS LAST
) = 1;

CREATE OR REPLACE TEMP TABLE mhi_v2_financial_events AS
SELECT *
FROM mhi_v2_financial_comparables
WHERE attributable_profit IS NOT NULL
  AND attributable_equity > 0
  AND prior_year_profit IS NOT NULL
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY instrumentKey, announcementDate
  ORDER BY reportPeriod DESC, fetchedAt DESC
) = 1;

CREATE OR REPLACE TEMP TABLE mhi_v2_daily_stock_fundamentals AS
WITH eligible_market AS (
  SELECT
    stock.instrumentKey,
    stock.tradeDate,
    stock.stock_return,
    bar.totalMarketCap,
    bar.peTtm,
    bar.pb
  FROM mhi_stock_windows AS stock
  INNER JOIN bars AS bar
    ON stock.instrumentKey = bar.instrumentKey
   AND stock.tradeDate = bar.tradeDate
  WHERE stock.history_count >= 120
    AND stock.stock_return IS NOT NULL
    AND stock.amount > 0
)
SELECT
  market.*,
  financial.reportPeriod AS financial_report_period,
  financial.announcementDate AS financial_announcement_date,
  financial.fiscalQuarter,
  financial.attributable_profit,
  financial.attributable_equity,
  financial.report_revenue,
  financial.netOperatingCashFlow,
  financial.prior_year_profit,
  financial.prior_year_equity,
  financial.prior_year_revenue,
  financial.annualized_roe,
  financial.prior_year_annualized_roe,
  financial.profit_change_yoy,
  financial.revenue_change_yoy
FROM eligible_market AS market
ASOF LEFT JOIN mhi_v2_financial_events AS financial
  ON market.instrumentKey = financial.instrumentKey
 AND market.tradeDate >= financial.announcementDate;

CREATE OR REPLACE TEMP TABLE mhi_v2_fundamental_raw AS
SELECT
  tradeDate,
  COUNT(*) AS eligible_stocks,
  COUNT(annualized_roe) AS roe_covered_stocks,
  COUNT(prior_year_profit) AS growth_covered_stocks,
  COUNT(netOperatingCashFlow) AS cashflow_covered_stocks,
  COUNT(CASE WHEN peTtm > 0 THEN 1 END) AS pe_covered_stocks,
  100.0 * COUNT(annualized_roe) / COUNT(*) AS roe_coverage_pct,
  100.0 * COUNT(prior_year_profit) / COUNT(*) AS growth_coverage_pct,
  100.0 * COUNT(netOperatingCashFlow) / COUNT(*) AS cashflow_coverage_pct,
  100.0 * SUM(
    CASE WHEN attributable_equity > 0
      THEN attributable_profit * (4.0 / NULLIF(fiscalQuarter, 0)) ELSE 0.0 END
  ) / NULLIF(SUM(CASE WHEN attributable_equity > 0 THEN attributable_equity ELSE 0.0 END), 0)
    AS aggregate_roe,
  100.0 * AVG(CASE WHEN annualized_roe IS NOT NULL AND annualized_roe > 0 THEN 1.0 ELSE 0.0 END)
    AS positive_roe_breadth,
  100.0 * AVG(CASE
    WHEN annualized_roe IS NOT NULL AND prior_year_annualized_roe IS NOT NULL
      AND annualized_roe > prior_year_annualized_roe THEN 1.0
    WHEN annualized_roe IS NOT NULL AND prior_year_annualized_roe IS NOT NULL THEN 0.0
    ELSE NULL END) AS improving_roe_breadth,
  SUM(CASE WHEN prior_year_profit IS NOT NULL THEN attributable_profit ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN prior_year_profit IS NOT NULL THEN prior_year_profit ELSE 0.0 END), 0)
    - 1.0 AS aggregate_profit_growth,
  100.0 * AVG(CASE
    WHEN prior_year_profit IS NOT NULL AND attributable_profit > prior_year_profit THEN 1.0
    WHEN prior_year_profit IS NOT NULL THEN 0.0
    ELSE NULL END) AS improving_profit_breadth,
  100.0 * AVG(CASE WHEN attributable_profit IS NOT NULL AND attributable_profit > 0 THEN 1.0
                   WHEN attributable_profit IS NOT NULL THEN 0.0 ELSE NULL END)
    AS profitable_company_breadth,
  SUM(CASE WHEN prior_year_revenue IS NOT NULL THEN report_revenue ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN prior_year_revenue IS NOT NULL THEN prior_year_revenue ELSE 0.0 END), 0)
    - 1.0 AS aggregate_revenue_growth,
  100.0 * AVG(CASE
    WHEN prior_year_revenue IS NOT NULL AND report_revenue > prior_year_revenue THEN 1.0
    WHEN prior_year_revenue IS NOT NULL THEN 0.0
    ELSE NULL END) AS improving_revenue_breadth,
  SUM(CASE WHEN attributable_profit > 0 THEN netOperatingCashFlow ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN attributable_profit > 0 THEN attributable_profit ELSE 0.0 END), 0)
    AS aggregate_cash_conversion,
  100.0 * AVG(CASE WHEN netOperatingCashFlow IS NOT NULL AND netOperatingCashFlow > 0 THEN 1.0
                   WHEN netOperatingCashFlow IS NOT NULL THEN 0.0 ELSE NULL END)
    AS positive_cashflow_breadth,
  SUM(CASE WHEN peTtm > 0 AND totalMarketCap > 0 THEN totalMarketCap ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN peTtm > 0 AND totalMarketCap > 0 THEN totalMarketCap / peTtm ELSE 0.0 END), 0)
    AS aggregate_pe,
  SUM(CASE WHEN pb > 0 AND totalMarketCap > 0 THEN totalMarketCap ELSE 0.0 END)
    / NULLIF(SUM(CASE WHEN pb > 0 AND totalMarketCap > 0 THEN totalMarketCap / pb ELSE 0.0 END), 0)
    AS aggregate_pb
FROM mhi_v2_daily_stock_fundamentals
GROUP BY tradeDate;

CREATE OR REPLACE TEMP TABLE mhi_v2_fundamental_history AS
SELECT
  *,
  COUNT(aggregate_roe) OVER history_window AS history_observations,
  MEDIAN(aggregate_roe) OVER history_window AS roe_med,
  QUANTILE_CONT(aggregate_roe, 0.25) OVER history_window AS roe_q25,
  QUANTILE_CONT(aggregate_roe, 0.75) OVER history_window AS roe_q75,
  MEDIAN(positive_roe_breadth) OVER history_window AS positive_roe_breadth_med,
  QUANTILE_CONT(positive_roe_breadth, 0.25) OVER history_window AS positive_roe_breadth_q25,
  QUANTILE_CONT(positive_roe_breadth, 0.75) OVER history_window AS positive_roe_breadth_q75,
  MEDIAN(improving_roe_breadth) OVER history_window AS improving_roe_breadth_med,
  QUANTILE_CONT(improving_roe_breadth, 0.25) OVER history_window AS improving_roe_breadth_q25,
  QUANTILE_CONT(improving_roe_breadth, 0.75) OVER history_window AS improving_roe_breadth_q75,
  MEDIAN(aggregate_profit_growth) OVER history_window AS profit_growth_med,
  QUANTILE_CONT(aggregate_profit_growth, 0.25) OVER history_window AS profit_growth_q25,
  QUANTILE_CONT(aggregate_profit_growth, 0.75) OVER history_window AS profit_growth_q75,
  MEDIAN(improving_profit_breadth) OVER history_window AS improving_profit_breadth_med,
  QUANTILE_CONT(improving_profit_breadth, 0.25) OVER history_window AS improving_profit_breadth_q25,
  QUANTILE_CONT(improving_profit_breadth, 0.75) OVER history_window AS improving_profit_breadth_q75,
  MEDIAN(aggregate_revenue_growth) OVER history_window AS revenue_growth_med,
  QUANTILE_CONT(aggregate_revenue_growth, 0.25) OVER history_window AS revenue_growth_q25,
  QUANTILE_CONT(aggregate_revenue_growth, 0.75) OVER history_window AS revenue_growth_q75,
  MEDIAN(improving_revenue_breadth) OVER history_window AS improving_revenue_breadth_med,
  QUANTILE_CONT(improving_revenue_breadth, 0.25) OVER history_window AS improving_revenue_breadth_q25,
  QUANTILE_CONT(improving_revenue_breadth, 0.75) OVER history_window AS improving_revenue_breadth_q75,
  MEDIAN(aggregate_cash_conversion) OVER history_window AS cash_conversion_med,
  QUANTILE_CONT(aggregate_cash_conversion, 0.25) OVER history_window AS cash_conversion_q25,
  QUANTILE_CONT(aggregate_cash_conversion, 0.75) OVER history_window AS cash_conversion_q75,
  MEDIAN(aggregate_pe) OVER history_window AS pe_med,
  QUANTILE_CONT(aggregate_pe, 0.25) OVER history_window AS pe_q25,
  QUANTILE_CONT(aggregate_pe, 0.75) OVER history_window AS pe_q75,
  MEDIAN(aggregate_pb) OVER history_window AS pb_med,
  QUANTILE_CONT(aggregate_pb, 0.25) OVER history_window AS pb_q25,
  QUANTILE_CONT(aggregate_pb, 0.75) OVER history_window AS pb_q75
FROM mhi_v2_fundamental_raw
WINDOW history_window AS (ORDER BY tradeDate ROWS BETWEEN 756 PRECEDING AND 1 PRECEDING);

CREATE OR REPLACE TEMP TABLE mhi_v2_fundamental_scores AS
WITH sub_scores AS (
  SELECT
    *,
    mhi_good_score(aggregate_roe, roe_med, roe_q25, roe_q75) AS aggregate_roe_score,
    mhi_good_score(
      positive_roe_breadth, positive_roe_breadth_med,
      positive_roe_breadth_q25, positive_roe_breadth_q75
    ) AS positive_roe_breadth_score,
    mhi_good_score(
      improving_roe_breadth, improving_roe_breadth_med,
      improving_roe_breadth_q25, improving_roe_breadth_q75
    ) AS improving_roe_breadth_score,
    mhi_good_score(
      aggregate_profit_growth, profit_growth_med, profit_growth_q25, profit_growth_q75
    ) AS aggregate_profit_growth_score,
    mhi_good_score(
      aggregate_revenue_growth, revenue_growth_med, revenue_growth_q25, revenue_growth_q75
    ) AS aggregate_revenue_growth_score,
    mhi_good_score(
      improving_profit_breadth, improving_profit_breadth_med,
      improving_profit_breadth_q25, improving_profit_breadth_q75
    ) AS improving_profit_breadth_score,
    mhi_good_score(
      improving_revenue_breadth, improving_revenue_breadth_med,
      improving_revenue_breadth_q25, improving_revenue_breadth_q75
    ) AS improving_revenue_breadth_score,
    mhi_good_score(
      aggregate_cash_conversion, cash_conversion_med, cash_conversion_q25, cash_conversion_q75
    ) AS cash_conversion_score,
    mhi_good_score(aggregate_pe, pe_med, pe_q25, pe_q75) AS pe_pressure_score,
    mhi_good_score(aggregate_pb, pb_med, pb_q25, pb_q75) AS pb_pressure_score
  FROM mhi_v2_fundamental_history
  WHERE history_observations >= 252
), components AS (
  SELECT
    *,
    0.50 * aggregate_roe_score
      + 0.25 * improving_roe_breadth_score
      + 0.25 * positive_roe_breadth_score
      AS profitability_score,
    0.50 * aggregate_profit_growth_score
      + 0.30 * improving_profit_breadth_score
      + 0.20 * improving_revenue_breadth_score
      AS earnings_growth_score,
    0.60 * cash_conversion_score
      + 0.40 * LEAST(100.0, GREATEST(0.0, positive_cashflow_breadth))
      AS earnings_quality_score,
    0.50 * pe_pressure_score + 0.50 * pb_pressure_score AS valuation_pressure
  FROM sub_scores
)
SELECT
  *,
  0.50 * profitability_score + 0.50 * earnings_growth_score AS fundamental_health
FROM components
WHERE roe_coverage_pct >= 30.0
  AND growth_coverage_pct >= 30.0;

CREATE OR REPLACE TEMP TABLE mhi_v2_joined AS
SELECT
  technical.*,
  fundamental.roe_coverage_pct,
  fundamental.growth_coverage_pct,
  fundamental.cashflow_coverage_pct,
  fundamental.aggregate_roe,
  fundamental.aggregate_profit_growth,
  fundamental.aggregate_revenue_growth,
  fundamental.aggregate_cash_conversion,
  fundamental.aggregate_pe,
  fundamental.aggregate_pb,
  fundamental.profitability_score,
  fundamental.earnings_growth_score,
  fundamental.earnings_quality_score,
  fundamental.fundamental_health,
  fundamental.valuation_pressure,
  100.0 - fundamental.valuation_pressure AS valuation_support,
  (technical.mhi + fundamental.fundamental_health) / 2.0 AS technical_fundamental_equal,
  (technical.mhi + fundamental.fundamental_health + 100.0 - fundamental.valuation_pressure) / 3.0
    AS three_axis_equal
FROM mhi_components AS technical
INNER JOIN mhi_v2_fundamental_scores AS fundamental USING (tradeDate);

CREATE OR REPLACE TEMP TABLE mhi_v2_market_labels AS
SELECT
  tradeDate,
  LEAD(equal_weight_index, 20) OVER calendar_window / equal_weight_index - 1.0 AS forward_return_20d,
  LEAD(equal_weight_index, 60) OVER calendar_window / equal_weight_index - 1.0 AS forward_return_60d,
  LEAD(equal_weight_index, 126) OVER calendar_window / equal_weight_index - 1.0 AS forward_return_126d,
  LEAD(equal_weight_index, 252) OVER calendar_window / equal_weight_index - 1.0 AS forward_return_252d,
  LEAD(tradeDate, 252) OVER calendar_window AS forward_date_252d,
  MIN(equal_weight_index) OVER (
    ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING
  ) / equal_weight_index - 1.0 AS forward_worst_return_20d,
  SQRT(252.0 * AVG(POWER(LEAST(equal_weight_return, 0.0), 2)) OVER (
    ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING
  )) AS forward_downside_semivol_20d
FROM mhi_components
WINDOW calendar_window AS (ORDER BY tradeDate);

CREATE OR REPLACE TEMP TABLE mhi_v2_labeled AS
SELECT
  current_score.*,
  label.forward_return_20d,
  label.forward_return_60d,
  label.forward_return_126d,
  label.forward_return_252d,
  label.forward_worst_return_20d,
  label.forward_downside_semivol_20d,
  future_score.aggregate_roe - current_score.aggregate_roe AS forward_roe_change_252d
FROM mhi_v2_joined AS current_score
INNER JOIN mhi_v2_market_labels AS label USING (tradeDate)
LEFT JOIN mhi_v2_fundamental_scores AS future_score
  ON label.forward_date_252d = future_score.tradeDate
WHERE current_score.tradeDate BETWEEN CAST($evaluationStartDate AS DATE)
                                  AND CAST($evaluationEndDate AS DATE);

CREATE OR REPLACE TEMP TABLE mhi_v2_validated AS
SELECT
  *,
  CASE WHEN forward_worst_return_20d <= -0.08 THEN 1 ELSE 0 END AS severe_drawdown_20d
FROM mhi_v2_labeled
WHERE forward_return_20d IS NOT NULL
  AND forward_return_60d IS NOT NULL
  AND forward_worst_return_20d IS NOT NULL
  AND forward_downside_semivol_20d IS NOT NULL;

SELECT
  MIN(tradeDate) AS evaluation_start,
  MAX(tradeDate) AS short_horizon_evaluation_end,
  MAX(CASE WHEN forward_return_252d IS NOT NULL THEN tradeDate END) AS long_horizon_evaluation_end,
  COUNT(*) AS evaluated_days,
  ROUND(MIN(roe_coverage_pct), 2) AS min_roe_coverage_pct,
  ROUND(AVG(roe_coverage_pct), 2) AS average_roe_coverage_pct,
  ROUND(MIN(growth_coverage_pct), 2) AS min_growth_coverage_pct,
  ROUND(AVG(growth_coverage_pct), 2) AS average_growth_coverage_pct,
  ROUND(MIN(cashflow_coverage_pct), 2) AS min_cashflow_coverage_pct,
  ROUND(AVG(cashflow_coverage_pct), 2) AS average_cashflow_coverage_pct,
  'financial facts become usable on announcementDate; corrections retain their later announcementDate' AS point_in_time_rule,
  'weights were fixed before validation; no search or outcome-based optimization' AS fitting_rule
FROM mhi_v2_validated;

SELECT
  MIN(tradeDate) AS evaluation_start,
  MAX(tradeDate) AS evaluation_end,
  COUNT(*) AS evaluated_days,
  MIN(eligible_stocks) AS min_eligible_stocks,
  MAX(eligible_stocks) AS max_eligible_stocks,
  ROUND(AVG(eligible_stocks), 0) AS average_eligible_stocks,
  CAST($sourceStartDate AS DATE) AS source_start,
  CAST($evaluationStartDate AS DATE) AS requested_evaluation_start,
  CAST($evaluationEndDate AS DATE) AS requested_evaluation_end,
  'qfq_adjusted_stock_price' AS stock_return_basis,
  'official_price_index' AS index_return_basis,
  756 AS normalization_lookback_days,
  252 AS minimum_normalization_history,
  'MSI proxy excludes the extreme-limit factor and re-normalizes A/B/C weights' AS msi_proxy_note
FROM mhi_validated;

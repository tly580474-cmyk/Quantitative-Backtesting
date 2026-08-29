WITH signals AS (
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_252d, severe_drawdown_20d, 'market_structure_health' AS signal, mhi AS score
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_252d, severe_drawdown_20d, 'fundamental_health', fundamental_health
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_252d, severe_drawdown_20d, 'valuation_support', valuation_support
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_252d, severe_drawdown_20d, 'technical_fundamental_equal', technical_fundamental_equal
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_252d, severe_drawdown_20d, 'three_axis_equal', three_axis_equal
  FROM mhi_v2_validated
), ranked AS (
  SELECT *, NTILE(10) OVER (PARTITION BY signal ORDER BY score) AS score_decile
  FROM signals
), summarized AS (
  SELECT
    signal,
    AVG(CASE WHEN score_decile = 1 THEN severe_drawdown_20d END) AS bottom_severe_rate,
    AVG(CASE WHEN score_decile = 10 THEN severe_drawdown_20d END) AS top_severe_rate,
    AVG(CASE WHEN score_decile = 1 THEN forward_downside_semivol_20d END) AS bottom_downside_vol,
    AVG(CASE WHEN score_decile = 10 THEN forward_downside_semivol_20d END) AS top_downside_vol,
    AVG(CASE WHEN score_decile = 1 THEN forward_worst_return_20d END) AS bottom_worst_return,
    AVG(CASE WHEN score_decile = 10 THEN forward_worst_return_20d END) AS top_worst_return,
    AVG(CASE WHEN score_decile = 1 THEN forward_return_252d END) AS bottom_return_252d,
    AVG(CASE WHEN score_decile = 10 THEN forward_return_252d END) AS top_return_252d
  FROM ranked
  GROUP BY signal
)
SELECT
  signal,
  ROUND((bottom_severe_rate - top_severe_rate) * 100.0, 4) AS bottom_minus_top_severe_rate_pct,
  ROUND((bottom_downside_vol - top_downside_vol) * 100.0, 4) AS bottom_minus_top_downside_vol_pct,
  ROUND((top_worst_return - bottom_worst_return) * 100.0, 4) AS top_minus_bottom_worst_return_pct,
  ROUND((top_return_252d - bottom_return_252d) * 100.0, 4) AS top_minus_bottom_return_252d_pct
FROM summarized
ORDER BY signal;

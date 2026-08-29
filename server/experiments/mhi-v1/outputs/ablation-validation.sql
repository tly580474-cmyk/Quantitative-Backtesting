WITH signals AS (
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d, severe_drawdown_20d,
         'full_mhi' AS signal, mhi AS score FROM mhi_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d, severe_drawdown_20d,
         'without_trend', mhi_without_trend FROM mhi_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d, severe_drawdown_20d,
         'without_participation', mhi_without_participation FROM mhi_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d, severe_drawdown_20d,
         'without_risk', mhi_without_risk FROM mhi_validated
  UNION ALL
  SELECT tradeDate, forward_worst_return_20d, forward_downside_semivol_20d, severe_drawdown_20d,
         'without_liquidity', mhi_without_liquidity FROM mhi_validated
), ranked AS (
  SELECT *, NTILE(10) OVER (PARTITION BY signal ORDER BY score) AS score_decile
  FROM signals
), edges AS (
  SELECT
    signal,
    AVG(CASE WHEN score_decile = 1 THEN severe_drawdown_20d END) AS bottom_severe_rate,
    AVG(CASE WHEN score_decile = 10 THEN severe_drawdown_20d END) AS top_severe_rate,
    AVG(CASE WHEN score_decile = 1 THEN forward_downside_semivol_20d END) AS bottom_downside_vol,
    AVG(CASE WHEN score_decile = 10 THEN forward_downside_semivol_20d END) AS top_downside_vol,
    AVG(CASE WHEN score_decile = 1 THEN forward_worst_return_20d END) AS bottom_worst_return,
    AVG(CASE WHEN score_decile = 10 THEN forward_worst_return_20d END) AS top_worst_return
  FROM ranked
  GROUP BY signal
)
SELECT
  signal,
  ROUND((bottom_severe_rate - top_severe_rate) * 100.0, 4) AS bottom_minus_top_severe_rate_pct,
  ROUND((bottom_downside_vol - top_downside_vol) * 100.0, 4) AS bottom_minus_top_downside_vol_pct,
  ROUND((top_worst_return - bottom_worst_return) * 100.0, 4) AS top_minus_bottom_worst_return_pct
FROM edges
ORDER BY signal;

WITH axes AS (
  SELECT tradeDate, 'growth_cycle' AS axis, growth_cycle_score AS score,
         forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_60d, forward_return_126d, forward_return_252d,
         forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v3_monthly_sample
  UNION ALL SELECT tradeDate, 'nominal_cycle', nominal_cycle_score,
         forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_60d, forward_return_126d, forward_return_252d,
         forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v3_monthly_sample
  UNION ALL SELECT tradeDate, 'money_activity', money_activity_score,
         forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_60d, forward_return_126d, forward_return_252d,
         forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v3_monthly_sample WHERE money_activity_score IS NOT NULL
  UNION ALL SELECT tradeDate, 'market_structure_health', mhi,
         forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_60d, forward_return_126d, forward_return_252d,
         forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v3_monthly_sample
  UNION ALL SELECT tradeDate, 'fundamental_health', fundamental_health,
         forward_worst_return_20d, forward_downside_semivol_20d,
         forward_return_60d, forward_return_126d, forward_return_252d,
         forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v3_monthly_sample
), ranked AS (
  SELECT *, NTILE(5) OVER (PARTITION BY axis ORDER BY score) AS quintile
  FROM axes
)
SELECT
  axis,
  COUNT(*) AS monthly_observations,
  COUNT(forward_return_252d) AS long_horizon_observations,
  ROUND(CORR(score, forward_worst_return_20d), 6) AS corr_worst_return_20d,
  ROUND(CORR(score, forward_downside_semivol_20d), 6) AS corr_downside_semivol_20d,
  ROUND(CORR(score, forward_return_60d), 6) AS corr_return_60d,
  ROUND(CORR(score, forward_return_126d), 6) AS corr_return_126d,
  ROUND(CORR(score, forward_return_252d), 6) AS corr_return_252d,
  ROUND(CORR(score, forward_roe_change_252d), 6) AS corr_roe_change_252d,
  ROUND(100.0 * (AVG(CASE WHEN quintile = 1 THEN severe_drawdown_20d END)
    - AVG(CASE WHEN quintile = 5 THEN severe_drawdown_20d END)), 4) AS bottom_minus_top_severe_rate_pct,
  ROUND(100.0 * (AVG(CASE WHEN quintile = 5 THEN forward_worst_return_20d END)
    - AVG(CASE WHEN quintile = 1 THEN forward_worst_return_20d END)), 4) AS top_minus_bottom_worst_return_pct,
  ROUND(100.0 * (AVG(CASE WHEN quintile = 5 THEN forward_return_60d END)
    - AVG(CASE WHEN quintile = 1 THEN forward_return_60d END)), 4) AS top_minus_bottom_return_60d_pct,
  ROUND(100.0 * (AVG(CASE WHEN quintile = 5 THEN forward_return_252d END)
    - AVG(CASE WHEN quintile = 1 THEN forward_return_252d END)), 4) AS top_minus_bottom_return_252d_pct
FROM ranked
GROUP BY axis
ORDER BY axis;

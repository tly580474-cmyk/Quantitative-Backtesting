WITH axes AS (
  SELECT 'growth_cycle' AS axis, growth_cycle_score AS score, * EXCLUDE (growth_cycle_score) FROM mhi_v3_validated
  UNION ALL SELECT 'nominal_cycle', nominal_cycle_score, * EXCLUDE (nominal_cycle_score) FROM mhi_v3_validated
  UNION ALL SELECT 'money_activity', money_activity_score, * EXCLUDE (money_activity_score)
    FROM mhi_v3_validated WHERE money_activity_score IS NOT NULL
), ranked AS (
  SELECT *, NTILE(10) OVER (PARTITION BY axis ORDER BY score) AS decile FROM axes
)
SELECT axis, COUNT(*) AS daily_observations,
  ROUND(CORR(score, forward_return_60d), 6) AS corr_return_60d,
  ROUND(CORR(score, forward_return_252d), 6) AS corr_return_252d,
  ROUND(100.0 * (AVG(CASE WHEN decile = 1 THEN severe_drawdown_20d END)
    - AVG(CASE WHEN decile = 10 THEN severe_drawdown_20d END)), 4) AS bottom_minus_top_severe_rate_pct,
  ROUND(100.0 * (AVG(CASE WHEN decile = 10 THEN forward_return_252d END)
    - AVG(CASE WHEN decile = 1 THEN forward_return_252d END)), 4) AS top_minus_bottom_return_252d_pct
FROM ranked GROUP BY axis ORDER BY axis;

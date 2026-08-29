WITH base AS (
  SELECT *, CASE
    WHEN tradeDate < DATE '2014-01-01' THEN '2011-2013'
    WHEN tradeDate < DATE '2018-01-01' THEN '2014-2017'
    WHEN tradeDate < DATE '2022-01-01' THEN '2018-2021'
    ELSE '2022-2026' END AS era
  FROM mhi_v3_monthly_sample
), axes AS (
  SELECT era, 'growth_cycle' AS axis, growth_cycle_score AS score, forward_worst_return_20d,
         forward_return_60d, forward_return_252d, severe_drawdown_20d FROM base
  UNION ALL SELECT era, 'nominal_cycle', nominal_cycle_score, forward_worst_return_20d,
         forward_return_60d, forward_return_252d, severe_drawdown_20d FROM base
  UNION ALL SELECT era, 'money_activity', money_activity_score, forward_worst_return_20d,
         forward_return_60d, forward_return_252d, severe_drawdown_20d FROM base
         WHERE money_activity_score IS NOT NULL
), ranked AS (
  SELECT *, NTILE(2) OVER (PARTITION BY era, axis ORDER BY score) AS half FROM axes
)
SELECT era, axis, COUNT(*) AS monthly_observations,
  ROUND(CORR(score, forward_return_60d), 6) AS corr_return_60d,
  ROUND(CORR(score, forward_return_252d), 6) AS corr_return_252d,
  ROUND(100.0 * (AVG(CASE WHEN half = 1 THEN severe_drawdown_20d END)
    - AVG(CASE WHEN half = 2 THEN severe_drawdown_20d END)), 4) AS low_minus_high_severe_rate_pct,
  ROUND(100.0 * (AVG(CASE WHEN half = 2 THEN forward_return_60d END)
    - AVG(CASE WHEN half = 1 THEN forward_return_60d END)), 4) AS high_minus_low_return_60d_pct
FROM ranked GROUP BY era, axis ORDER BY era, axis;

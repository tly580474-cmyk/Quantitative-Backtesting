WITH axes AS (
  SELECT *, 'growth_cycle' AS macro_axis, growth_cycle_score AS macro_score
  FROM mhi_v3_monthly_sample
  UNION ALL
  SELECT *, 'nominal_cycle' AS macro_axis, nominal_cycle_score AS macro_score
  FROM mhi_v3_monthly_sample
  UNION ALL
  SELECT *, 'money_activity' AS macro_axis, money_activity_score AS macro_score
  FROM mhi_v3_monthly_sample
  WHERE money_activity_score IS NOT NULL
), states AS (
  SELECT *,
    CASE WHEN fundamental_health >= 50 THEN 'fundamental_strong' ELSE 'fundamental_weak' END
      || ' / ' ||
    CASE WHEN macro_score >= 50 THEN 'macro_strong' ELSE 'macro_weak' END AS state
  FROM axes
)
SELECT
  macro_axis,
  state,
  COUNT(*) AS monthly_observations,
  ROUND(AVG(aggregate_roe), 4) AS current_aggregate_roe_pct,
  ROUND(AVG(forward_roe_change_252d), 4) AS average_forward_roe_change_252d_pct,
  ROUND(AVG(forward_return_60d) * 100.0, 4) AS average_return_60d_pct,
  ROUND(AVG(forward_return_252d) * 100.0, 4) AS average_return_252d_pct,
  ROUND(AVG(severe_drawdown_20d) * 100.0, 4) AS severe_drawdown_rate_pct
FROM states
GROUP BY macro_axis, state
ORDER BY macro_axis, state;

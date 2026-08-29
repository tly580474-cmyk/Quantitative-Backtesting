WITH regimes AS (
  SELECT *,
    CASE WHEN mhi >= 50 THEN 'structure_strong' ELSE 'structure_weak' END || ' / ' ||
    CASE WHEN fundamental_health >= 50 THEN 'fundamental_strong' ELSE 'fundamental_weak' END || ' / ' ||
    CASE WHEN growth_cycle_score >= 50 THEN 'macro_growth_strong' ELSE 'macro_growth_weak' END AS regime
  FROM mhi_v3_monthly_sample
)
SELECT regime, COUNT(*) AS monthly_observations,
  ROUND(AVG(severe_drawdown_20d) * 100.0, 4) AS severe_drawdown_rate_pct,
  ROUND(AVG(forward_worst_return_20d) * 100.0, 4) AS average_worst_return_20d_pct,
  ROUND(AVG(forward_return_60d) * 100.0, 4) AS average_return_60d_pct,
  ROUND(AVG(forward_return_252d) * 100.0, 4) AS average_return_252d_pct
FROM regimes GROUP BY regime ORDER BY regime;

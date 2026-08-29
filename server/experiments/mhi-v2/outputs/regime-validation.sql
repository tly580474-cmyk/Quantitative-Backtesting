WITH regimes AS (
  SELECT
    *,
    CASE WHEN fundamental_health >= 50 THEN 'fundamental_strong' ELSE 'fundamental_weak' END
      || ' / '
      || CASE WHEN valuation_pressure >= 50 THEN 'valuation_high' ELSE 'valuation_low' END
      || ' / '
      || CASE WHEN mhi >= 50 THEN 'structure_strong' ELSE 'structure_weak' END AS regime
  FROM mhi_v2_validated
)
SELECT
  regime,
  COUNT(*) AS observations,
  ROUND(AVG(severe_drawdown_20d) * 100.0, 4) AS severe_drawdown_rate_pct,
  ROUND(AVG(forward_worst_return_20d) * 100.0, 4) AS average_forward_worst_return_20d_pct,
  ROUND(AVG(forward_downside_semivol_20d) * 100.0, 4) AS average_forward_downside_semivol_20d_pct,
  ROUND(AVG(forward_return_60d) * 100.0, 4) AS average_forward_return_60d_pct,
  ROUND(AVG(forward_return_252d) * 100.0, 4) AS average_forward_return_252d_pct
FROM regimes
GROUP BY regime
ORDER BY regime;

SELECT
  mhi_decile,
  COUNT(*) AS observations,
  ROUND(MIN(mhi), 4) AS min_mhi,
  ROUND(AVG(mhi), 4) AS average_mhi,
  ROUND(MAX(mhi), 4) AS max_mhi,
  ROUND(AVG(forward_worst_return_20d) * 100.0, 4) AS average_forward_worst_return_20d_pct,
  ROUND(AVG(severe_drawdown_20d) * 100.0, 4) AS severe_drawdown_rate_pct,
  ROUND(AVG(forward_downside_semivol_20d) * 100.0, 4) AS average_forward_downside_semivol_20d_pct,
  ROUND(AVG(forward_return_20d) * 100.0, 4) AS average_forward_return_20d_pct,
  ROUND(AVG(forward_return_60d) * 100.0, 4) AS average_forward_return_60d_pct
FROM mhi_validated
GROUP BY mhi_decile
ORDER BY mhi_decile;

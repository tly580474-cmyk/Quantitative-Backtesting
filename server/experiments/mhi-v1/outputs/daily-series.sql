SELECT
  tradeDate,
  ROUND(mhi, 4) AS mhi,
  ROUND(trend_score, 4) AS trend_score,
  ROUND(participation_score, 4) AS participation_score,
  ROUND(risk_score, 4) AS risk_score,
  ROUND(liquidity_score, 4) AS liquidity_score,
  ROUND(msi_proxy, 4) AS msi_proxy,
  eligible_stocks,
  ROUND(forward_return_20d * 100.0, 4) AS forward_return_20d_pct,
  ROUND(forward_return_60d * 100.0, 4) AS forward_return_60d_pct,
  ROUND(forward_worst_return_20d * 100.0, 4) AS forward_worst_return_20d_pct,
  ROUND(forward_downside_semivol_20d * 100.0, 4) AS forward_downside_semivol_20d_pct,
  severe_drawdown_20d,
  mhi_decile
FROM mhi_validated
ORDER BY tradeDate;

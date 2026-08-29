SELECT
  tradeDate,
  ROUND(mhi, 4) AS market_structure_health,
  ROUND(fundamental_health, 4) AS fundamental_health,
  ROUND(valuation_pressure, 4) AS valuation_pressure,
  ROUND(growth_cycle_score, 4) AS growth_cycle_score,
  ROUND(nominal_cycle_score, 4) AS nominal_cycle_score,
  ROUND(money_activity_score, 4) AS money_activity_score,
  pmi_observation_month,
  ppi_observation_month,
  money_observation_month,
  ROUND(forward_worst_return_20d * 100.0, 4) AS forward_worst_return_20d_pct,
  ROUND(forward_return_60d * 100.0, 4) AS forward_return_60d_pct,
  ROUND(forward_return_252d * 100.0, 4) AS forward_return_252d_pct,
  severe_drawdown_20d
FROM mhi_v3_validated
ORDER BY tradeDate;

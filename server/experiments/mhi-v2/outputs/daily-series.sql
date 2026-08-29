SELECT
  tradeDate,
  ROUND(mhi, 4) AS market_structure_health,
  ROUND(fundamental_health, 4) AS fundamental_health,
  ROUND(valuation_pressure, 4) AS valuation_pressure,
  ROUND(technical_fundamental_equal, 4) AS technical_fundamental_equal,
  ROUND(three_axis_equal, 4) AS three_axis_equal,
  ROUND(profitability_score, 4) AS profitability_score,
  ROUND(earnings_growth_score, 4) AS earnings_growth_score,
  ROUND(earnings_quality_score, 4) AS earnings_quality_score,
  ROUND(aggregate_roe, 4) AS aggregate_roe_pct,
  ROUND(aggregate_profit_growth * 100.0, 4) AS aggregate_profit_growth_pct,
  ROUND(aggregate_pe, 4) AS aggregate_pe,
  ROUND(roe_coverage_pct, 2) AS roe_coverage_pct,
  ROUND(growth_coverage_pct, 2) AS growth_coverage_pct,
  ROUND(forward_worst_return_20d * 100.0, 4) AS forward_worst_return_20d_pct,
  ROUND(forward_return_252d * 100.0, 4) AS forward_return_252d_pct,
  severe_drawdown_20d
FROM mhi_v2_validated
ORDER BY tradeDate;

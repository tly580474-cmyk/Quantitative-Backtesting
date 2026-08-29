SELECT
  tradeDate AS sampled_trade_date,
  pmi_observation_month,
  pmi_availability_date,
  ROUND(manufacturing_pmi, 4) AS manufacturing_pmi,
  ROUND(pmi_change_3m, 4) AS pmi_change_3m,
  ROUND(growth_cycle_score, 4) AS growth_cycle_score,
  ppi_observation_month,
  ppi_availability_date,
  ROUND(ppi_yoy, 4) AS ppi_yoy,
  ROUND(ppi_change_3m, 4) AS ppi_change_3m,
  ROUND(nominal_cycle_score, 4) AS nominal_cycle_score,
  money_observation_month,
  money_availability_date,
  ROUND(m1_yoy, 4) AS m1_yoy,
  ROUND(m2_yoy, 4) AS m2_yoy,
  ROUND(m1_m2_gap, 4) AS m1_m2_gap,
  ROUND(gap_change_3m, 4) AS gap_change_3m,
  ROUND(money_activity_score, 4) AS money_activity_score
FROM mhi_v3_monthly_sample
ORDER BY tradeDate;

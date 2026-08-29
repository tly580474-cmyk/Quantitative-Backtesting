SELECT
  MIN(tradeDate) AS first_evaluation_date,
  MAX(tradeDate) AS last_evaluation_date,
  COUNT(*) AS daily_observations,
  COUNT(DISTINCT DATE_TRUNC('month', tradeDate)) AS monthly_observations,
  COUNT(forward_return_252d) AS daily_long_horizon_observations,
  MIN(pmi_observation_month) AS first_pmi_observation,
  MAX(pmi_observation_month) AS last_pmi_observation,
  MIN(ppi_observation_month) AS first_ppi_observation,
  MAX(ppi_observation_month) AS last_ppi_observation,
  MIN(money_observation_month) AS first_money_observation,
  MAX(money_observation_month) AS last_money_observation,
  MAX(DATE_DIFF('day', pmi_observation_month + INTERVAL 1 MONTH, pmi_availability_date)) AS max_pmi_lag_after_month,
  MAX(DATE_DIFF('day', ppi_observation_month + INTERVAL 1 MONTH, ppi_availability_date)) AS max_ppi_lag_after_month,
  MAX(DATE_DIFF('day', money_observation_month + INTERVAL 1 MONTH, money_availability_date)) AS max_money_lag_after_month
FROM mhi_v3_validated;

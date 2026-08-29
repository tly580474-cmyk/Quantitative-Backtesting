WITH episodes AS (
  SELECT '2015_crash' AS episode, DATE '2015-06-01' AS start_date, DATE '2015-09-30' AS end_date
  UNION ALL SELECT '2018_bear', DATE '2018-01-01', DATE '2018-12-31'
  UNION ALL SELECT '2020_covid', DATE '2020-01-01', DATE '2020-04-30'
  UNION ALL SELECT '2022_stress', DATE '2022-01-01', DATE '2022-10-31'
  UNION ALL SELECT '2024_q1', DATE '2024-01-01', DATE '2024-03-31'
)
SELECT
  episode,
  MIN(tradeDate) AS first_trade_date,
  MAX(tradeDate) AS last_trade_date,
  COUNT(*) AS observations,
  ROUND(MIN(mhi), 4) AS minimum_mhi,
  ROUND(AVG(mhi), 4) AS average_mhi,
  ROUND(MAX(mhi), 4) AS maximum_mhi,
  ROUND(MIN(forward_worst_return_20d) * 100.0, 4) AS worst_forward_20d_pct,
  ROUND(AVG(severe_drawdown_20d) * 100.0, 4) AS severe_drawdown_rate_pct,
  ROUND(AVG(forward_downside_semivol_20d) * 100.0, 4) AS average_forward_downside_semivol_pct
FROM episodes
INNER JOIN mhi_validated ON tradeDate BETWEEN start_date AND end_date
GROUP BY episode
ORDER BY first_trade_date;

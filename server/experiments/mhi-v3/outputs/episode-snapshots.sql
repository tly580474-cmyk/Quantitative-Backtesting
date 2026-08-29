WITH episodes(episode, target_date) AS (VALUES
  ('2011 tightening aftermath', DATE '2011-04-18'),
  ('2015 equity peak', DATE '2015-06-12'),
  ('2018 deleveraging', DATE '2018-01-24'),
  ('2022 growth slowdown', DATE '2022-01-04'),
  ('2024 market stress', DATE '2024-01-02')
), matched AS (
  SELECT episodes.*, sample.*,
    ROW_NUMBER() OVER (PARTITION BY episode ORDER BY ABS(DATE_DIFF('day', target_date, tradeDate))) AS proximity
  FROM episodes CROSS JOIN mhi_v3_monthly_sample AS sample
)
SELECT episode, target_date, tradeDate AS sampled_trade_date,
  ROUND(mhi, 4) AS market_structure_health,
  ROUND(fundamental_health, 4) AS fundamental_health,
  ROUND(valuation_pressure, 4) AS valuation_pressure,
  ROUND(growth_cycle_score, 4) AS growth_cycle_score,
  ROUND(nominal_cycle_score, 4) AS nominal_cycle_score,
  ROUND(money_activity_score, 4) AS money_activity_score,
  ROUND(forward_worst_return_20d * 100.0, 4) AS forward_worst_return_20d_pct,
  ROUND(forward_return_60d * 100.0, 4) AS forward_return_60d_pct,
  ROUND(forward_return_252d * 100.0, 4) AS forward_return_252d_pct
FROM matched WHERE proximity = 1 ORDER BY target_date;

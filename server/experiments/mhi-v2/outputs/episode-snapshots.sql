WITH requested(label, requested_date) AS (
  VALUES
    ('2007_peak', DATE '2007-10-16'),
    ('2008_pre_crash', DATE '2008-01-14'),
    ('2015_peak', DATE '2015-06-12'),
    ('2018_early', DATE '2018-01-24'),
    ('2020_pre_covid', DATE '2020-01-23'),
    ('2022_open', DATE '2022-01-04'),
    ('2024_open', DATE '2024-01-02')
)
SELECT
  requested.label,
  requested.requested_date,
  snapshot.tradeDate AS matched_trade_date,
  ROUND(snapshot.mhi, 4) AS market_structure_health,
  ROUND(snapshot.fundamental_health, 4) AS fundamental_health,
  ROUND(snapshot.valuation_pressure, 4) AS valuation_pressure,
  ROUND(snapshot.technical_fundamental_equal, 4) AS technical_fundamental_equal,
  ROUND(snapshot.three_axis_equal, 4) AS three_axis_equal,
  ROUND(snapshot.aggregate_roe, 4) AS aggregate_roe_pct,
  ROUND(snapshot.aggregate_profit_growth * 100.0, 4) AS aggregate_profit_growth_pct,
  ROUND(snapshot.aggregate_pe, 4) AS aggregate_pe,
  ROUND(snapshot.forward_worst_return_20d * 100.0, 4) AS forward_worst_return_20d_pct,
  snapshot.severe_drawdown_20d
FROM requested
ASOF LEFT JOIN mhi_v2_validated AS snapshot
  ON requested.requested_date >= snapshot.tradeDate
ORDER BY requested.requested_date;

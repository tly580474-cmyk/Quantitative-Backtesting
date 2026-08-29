WITH eras AS (
  SELECT
    *,
    CASE
      WHEN tradeDate < DATE '2012-01-01' THEN '2007-2011'
      WHEN tradeDate < DATE '2017-01-01' THEN '2012-2016'
      WHEN tradeDate < DATE '2022-01-01' THEN '2017-2021'
      ELSE '2022-2026'
    END AS era
  FROM mhi_v2_validated
), signals AS (
  SELECT era, severe_drawdown_20d, forward_worst_return_20d,
         'market_structure_health' AS signal, mhi AS score FROM eras
  UNION ALL
  SELECT era, severe_drawdown_20d, forward_worst_return_20d,
         'fundamental_health', fundamental_health FROM eras
  UNION ALL
  SELECT era, severe_drawdown_20d, forward_worst_return_20d,
         'valuation_support', valuation_support FROM eras
  UNION ALL
  SELECT era, severe_drawdown_20d, forward_worst_return_20d,
         'technical_fundamental_equal', technical_fundamental_equal FROM eras
  UNION ALL
  SELECT era, severe_drawdown_20d, forward_worst_return_20d,
         'three_axis_equal', three_axis_equal FROM eras
), ranked AS (
  SELECT *, NTILE(10) OVER (PARTITION BY era, signal ORDER BY score) AS era_decile
  FROM signals
)
SELECT
  era,
  signal,
  COUNT(*) AS observations,
  ROUND(100.0 * (
    AVG(CASE WHEN era_decile = 1 THEN severe_drawdown_20d END)
    - AVG(CASE WHEN era_decile = 10 THEN severe_drawdown_20d END)
  ), 4) AS bottom_minus_top_severe_rate_pct,
  ROUND(100.0 * (
    AVG(CASE WHEN era_decile = 10 THEN forward_worst_return_20d END)
    - AVG(CASE WHEN era_decile = 1 THEN forward_worst_return_20d END)
  ), 4) AS top_minus_bottom_worst_return_pct
FROM ranked
GROUP BY era, signal
ORDER BY era, signal;

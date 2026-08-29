WITH era_labeled AS (
  SELECT
    *,
    CASE
      WHEN tradeDate < DATE '2012-01-01' THEN '2007-2011'
      WHEN tradeDate < DATE '2017-01-01' THEN '2012-2016'
      WHEN tradeDate < DATE '2022-01-01' THEN '2017-2021'
      ELSE '2022-2026'
    END AS era
  FROM mhi_validated
), ranked AS (
  SELECT *, NTILE(10) OVER (PARTITION BY era ORDER BY mhi) AS era_decile
  FROM era_labeled
)
SELECT
  era,
  COUNT(*) AS observations,
  ROUND(CORR(mhi, msi_proxy), 6) AS mhi_msi_proxy_correlation,
  ROUND(100.0 * (
    AVG(CASE WHEN era_decile = 1 THEN severe_drawdown_20d END)
    - AVG(CASE WHEN era_decile = 10 THEN severe_drawdown_20d END)
  ), 4) AS bottom_minus_top_severe_rate_pct,
  ROUND(100.0 * (
    AVG(CASE WHEN era_decile = 1 THEN forward_downside_semivol_20d END)
    - AVG(CASE WHEN era_decile = 10 THEN forward_downside_semivol_20d END)
  ), 4) AS bottom_minus_top_downside_vol_pct,
  ROUND(100.0 * (
    AVG(CASE WHEN era_decile = 10 THEN forward_worst_return_20d END)
    - AVG(CASE WHEN era_decile = 1 THEN forward_worst_return_20d END)
  ), 4) AS top_minus_bottom_worst_return_pct
FROM ranked
GROUP BY era
ORDER BY era;

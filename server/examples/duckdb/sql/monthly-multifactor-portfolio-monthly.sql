WITH nav AS (
  SELECT *,
         1 + selectedCumulativeReturn AS selectedNav
  FROM multifactor_portfolio_monthly
),
drawdowns AS (
  SELECT *,
         selectedNav / MAX(selectedNav) OVER (
           ORDER BY signalMonth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) - 1 AS drawdown
  FROM nav
)
SELECT *
FROM drawdowns
ORDER BY signalMonth;

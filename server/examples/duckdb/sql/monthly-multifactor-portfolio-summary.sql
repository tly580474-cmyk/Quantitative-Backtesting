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
SELECT COUNT(*) AS monthCount,
       AVG(selectedPortfolioReturn) AS averageMonthlyReturn,
       STDDEV_SAMP(selectedPortfolioReturn) AS monthlyVolatility,
       EXP(AVG(LN(1 + selectedPortfolioReturn)) * 12) - 1 AS annualizedReturn,
       STDDEV_SAMP(selectedPortfolioReturn) * SQRT(12) AS annualizedVolatility,
       AVG(selectedPortfolioReturn)
         / NULLIF(STDDEV_SAMP(selectedPortfolioReturn), 0) * SQRT(12) AS annualizedSharpe,
       MAX(selectedCumulativeReturn) FILTER (
         WHERE signalMonth = (SELECT MAX(signalMonth) FROM drawdowns)
       ) AS cumulativeReturn,
       MAX(universeCumulativeReturn) FILTER (
         WHERE signalMonth = (SELECT MAX(signalMonth) FROM drawdowns)
       ) AS eligibleUniverseCumulativeReturn,
       MIN(drawdown) AS maxDrawdown,
       AVG(oneWayTurnover) AS averageOneWayTurnover,
       MIN(selectedPortfolioReturn) AS worstMonth,
       MAX(selectedPortfolioReturn) AS bestMonth
FROM drawdowns;

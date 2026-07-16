WITH configuration_returns AS (
  SELECT 'EQUAL_WEIGHT' AS configuration,
         signalMonth,
         equalWeightReturn AS monthlyReturn,
         equalWeightCumulativeReturn AS cumulativeReturn,
         equalWeightTurnover AS turnover
  FROM sw_industry_rotation_portfolio
  UNION ALL
  SELECT 'MARKET_CAP_WEIGHT',
         signalMonth,
         marketCapWeightReturn,
         marketCapWeightCumulativeReturn,
         marketCapWeightTurnover
  FROM sw_industry_rotation_portfolio
),
with_drawdown AS (
  SELECT *,
         (1 + cumulativeReturn)
           / MAX(1 + cumulativeReturn) OVER (
             PARTITION BY configuration
             ORDER BY signalMonth
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) - 1 AS drawdown
  FROM configuration_returns
)
SELECT configuration,
       COUNT(*) AS months,
       AVG(monthlyReturn) AS averageMonthlyReturn,
       STDDEV_SAMP(monthlyReturn) AS monthlyVolatility,
       EXP(AVG(LN(1 + monthlyReturn)) * 12) - 1 AS annualizedReturn,
       STDDEV_SAMP(monthlyReturn) * SQRT(12) AS annualizedVolatility,
       AVG(monthlyReturn) / NULLIF(STDDEV_SAMP(monthlyReturn), 0) * SQRT(12)
         AS annualizedSharpe,
       MAX(cumulativeReturn) FILTER (
         WHERE signalMonth = (SELECT MAX(signalMonth) FROM sw_industry_rotation_portfolio)
       ) AS cumulativeReturn,
       MIN(drawdown) AS maxDrawdown,
       AVG(CASE WHEN monthlyReturn > 0 THEN 1.0 ELSE 0.0 END) AS monthlyWinRate,
       AVG(turnover) AS averageOneWayTurnover,
       MIN(monthlyReturn) AS worstMonth,
       MAX(monthlyReturn) AS bestMonth
FROM with_drawdown
GROUP BY configuration
ORDER BY configuration;

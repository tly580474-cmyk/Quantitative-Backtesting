WITH monthly AS (
  SELECT signalMonth,
         factorLayer,
         ROUND(AVG(adjustedMonthlyReturn), 12) AS equalWeightReturn
  FROM multifactor_results
  GROUP BY signalMonth, factorLayer
),
summary AS (
  SELECT factorLayer,
         COUNT(*) AS months,
         ROUND(AVG(equalWeightReturn), 12) AS averageMonthlyReturn,
         ROUND(STDDEV_SAMP(equalWeightReturn), 12) AS monthlyVolatility,
         ROUND(EXP(AVG(LN(1 + equalWeightReturn)) * 12) - 1, 12) AS annualizedReturn,
         ROUND(STDDEV_SAMP(equalWeightReturn) * SQRT(12), 12) AS annualizedVolatility,
         ROUND(
           AVG(equalWeightReturn) / NULLIF(STDDEV_SAMP(equalWeightReturn), 0) * SQRT(12),
           12
         ) AS annualizedSharpe,
         ROUND(EXP(SUM(LN(1 + equalWeightReturn))) - 1, 12) AS cumulativeReturn,
         ROUND(
           AVG(CASE WHEN equalWeightReturn > 0 THEN 1.0 ELSE 0.0 END),
           12
         ) AS monthlyWinRate
  FROM monthly
  GROUP BY factorLayer
)
SELECT *,
       ROUND(
         MAX(CASE WHEN factorLayer = (SELECT MAX(factorLayer) FROM summary) THEN cumulativeReturn END)
           OVER ()
         - MAX(CASE WHEN factorLayer = 1 THEN cumulativeReturn END) OVER (),
         12
       ) AS topMinusBottomCumulativeSpread
FROM summary
ORDER BY factorLayer;

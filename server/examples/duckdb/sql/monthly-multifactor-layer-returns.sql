WITH monthly AS (
  SELECT signalMonth,
         factorLayer,
         COUNT(*) AS stockCount,
         ROUND(AVG(adjustedMonthlyReturn), 12) AS equalWeightReturn,
         ROUND(MEDIAN(adjustedMonthlyReturn), 12) AS medianReturn,
         ROUND(STDDEV_SAMP(adjustedMonthlyReturn), 12) AS returnStdDev,
         ROUND(
           AVG(CASE WHEN adjustedMonthlyReturn > 0 THEN 1.0 ELSE 0.0 END),
           12
         ) AS winRate
  FROM multifactor_results
  GROUP BY signalMonth, factorLayer
)
SELECT *,
       EXP(
         SUM(LN(1 + equalWeightReturn)) OVER (
           PARTITION BY factorLayer ORDER BY signalMonth
         )
       ) - 1 AS cumulativeReturn
FROM monthly
ORDER BY signalMonth, factorLayer;

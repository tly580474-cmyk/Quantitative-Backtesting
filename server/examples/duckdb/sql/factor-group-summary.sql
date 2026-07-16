SELECT factorLayer,
       COUNT(*) AS samples,
       COUNT(DISTINCT tradeDate) AS tradingDates,
       AVG(futureReturn) AS averageReturn,
       MEDIAN(futureReturn) AS medianReturn,
       STDDEV_SAMP(futureReturn) AS returnVolatility,
       AVG(CASE WHEN futureReturn > 0 THEN 1.0 ELSE 0.0 END) AS winRate
FROM factor_universe
GROUP BY factorLayer
ORDER BY factorLayer;

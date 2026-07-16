WITH latest AS (
  SELECT *
  FROM csi300_daily_performance
  ORDER BY tradeDate DESC
  LIMIT 1
)
SELECT CAST(DATE_TRUNC('month', CAST($startDate AS DATE)) AS DATE) AS rebalanceMonth,
       CAST($rebalanceDate AS DATE) AS benchmarkWeightDate,
       CAST($startDate AS DATE) AS periodStartDate,
       CAST($endDate AS DATE) AS periodEndDate,
       enhancedCumulativeReturn AS enhancedPortfolioReturn,
       constituentBenchmarkCumulativeReturn,
       officialIndexCumulativeReturn,
       constituentExcessReturn,
       officialIndexExcessReturn,
       activeShare,
       (SELECT MAX(ABS(activeWeightPct)) FROM csi300_target_portfolio)
         AS maxInitialAbsoluteWeightDeviationPct,
       (SELECT SUM(ABS(activeWeightPct)) / 2 / 100 FROM csi300_target_portfolio)
         AS initialActiveShare
FROM latest;

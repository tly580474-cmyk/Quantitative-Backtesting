SELECT tradeDate,
       symbol,
       name,
       level1Code,
       level1Name,
       MAX(dayStartBenchmarkWeightPct) AS dayStartBenchmarkWeightPct,
       MAX(dayStartTargetWeightPct) AS dayStartTargetWeightPct,
       MAX(dayStartActiveWeightPct) AS dayStartActiveWeightPct,
       SUM(benchmarkContribution) AS intradayBenchmarkContribution,
       SUM(enhancedContribution) AS intradayEnhancedContribution,
       SUM(excessContribution) AS intradayExcessContribution,
       COUNT(*) AS minuteCount
FROM csi300_minute_excess_detail
GROUP BY tradeDate, symbol, name, level1Code, level1Name
ORDER BY tradeDate, ABS(SUM(excessContribution)) DESC, symbol;

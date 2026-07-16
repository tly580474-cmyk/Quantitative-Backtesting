SELECT tradeDate,
       symbol,
       name,
       level1Code,
       level1Name,
       dynamicBenchmarkWeightPct,
       dynamicTargetWeightPct,
       dynamicActiveWeightPct,
       absoluteActiveWeightPct
FROM csi300_weight_deviation
ORDER BY tradeDate, absoluteActiveWeightPct DESC, symbol;

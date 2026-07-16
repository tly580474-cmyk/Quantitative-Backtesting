SELECT symbol,
       name,
       level1Code,
       level1Name,
       benchmarkWeightPct,
       targetWeightPct,
       activeWeightPct,
       peTtm,
       pb,
       valueScore,
       momentumScore,
       lowVolatilityScore,
       alphaScore,
       factorVersion
FROM csi300_target_portfolio
ORDER BY activeWeightPct DESC, symbol;

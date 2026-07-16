SELECT signalMonth,
       level1Code,
       level1Name,
       COUNT(*) AS selectedCount,
       COUNT(*) * 1.0 / SUM(COUNT(*)) OVER (PARTITION BY signalMonth) AS selectedWeight,
       AVG(compositeScore) AS averageCompositeScore,
       AVG(adjustedMonthlyReturn) AS equalWeightReturn
FROM multifactor_results
WHERE selected
GROUP BY signalMonth, level1Code, level1Name
ORDER BY signalMonth, selectedCount DESC, level1Code;

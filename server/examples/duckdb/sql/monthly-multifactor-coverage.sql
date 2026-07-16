SELECT calendar.signalMonth,
       calendar.signalDate,
       calendar.entryDate,
       calendar.exitDate,
       COUNT(raw.instrumentKey) AS rawUniverseCount,
       COUNT(raw.level1Code) AS industryCoveredCount,
       SUM(CASE WHEN raw.peTtm > 0 AND raw.pb > 0 THEN 1 ELSE 0 END) AS validValuationCount,
       SUM(CASE WHEN raw.adjustedCloseLag21 > 0 AND raw.adjustedCloseLag252 > 0 THEN 1 ELSE 0 END)
         AS validMomentumCount,
       SUM(CASE WHEN raw.trailingDividendEventCount > 0 THEN 1 ELSE 0 END)
         AS stocksWithTrailingDividend,
       COUNT(eligible.instrumentKey) AS eligibleCount,
       COUNT(result.instrumentKey) AS scoredCount,
       SUM(CASE WHEN result.selected THEN 1 ELSE 0 END) AS selectedCount
FROM multifactor_calendar AS calendar
LEFT JOIN multifactor_raw AS raw USING (signalMonth)
LEFT JOIN multifactor_eligible AS eligible
  ON eligible.signalMonth = raw.signalMonth
 AND eligible.instrumentKey = raw.instrumentKey
LEFT JOIN multifactor_results AS result
  ON result.signalMonth = raw.signalMonth
 AND result.instrumentKey = raw.instrumentKey
GROUP BY calendar.signalMonth, calendar.signalDate, calendar.entryDate, calendar.exitDate
ORDER BY calendar.signalMonth;

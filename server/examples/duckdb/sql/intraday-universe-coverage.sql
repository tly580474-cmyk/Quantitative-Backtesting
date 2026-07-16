SELECT universe.tradeDate,
       COUNT(DISTINCT universe.instrumentKey) AS eligibleSymbols,
       ANY_VALUE(aggregate.averageUniverseAmount20) AS averageUniverseAmount20,
       ANY_VALUE(aggregate.averageMarketCap) AS averageMarketCap,
       COUNT(DISTINCT signal.symbol) AS signaledSymbols,
       COUNT(signal.symbol) AS signalCount
FROM intraday_universe AS universe
INNER JOIN (
  SELECT tradeDate,
         AVG(averageAmount20) AS averageUniverseAmount20,
         AVG(totalMarketCap) AS averageMarketCap
  FROM intraday_universe
  GROUP BY tradeDate
) AS aggregate USING (tradeDate)
LEFT JOIN intraday_trading_signals AS signal
  ON signal.tradeDate = universe.tradeDate
 AND signal.instrumentKey = universe.instrumentKey
GROUP BY universe.tradeDate
ORDER BY universe.tradeDate;

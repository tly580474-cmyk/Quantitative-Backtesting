SELECT tradeDate,
       market,
       symbol,
       name,
       close,
       amount,
       momentum20,
       momentumPercentile,
       futureReturn
FROM factor_universe
WHERE tradeDate = (SELECT MAX(tradeDate) FROM factor_universe)
ORDER BY momentum20 DESC
LIMIT 50;

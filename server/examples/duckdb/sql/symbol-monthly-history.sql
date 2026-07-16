SELECT symbol,
       name,
       DATE_TRUNC('month', tradeDate) AS month,
       FIRST(open ORDER BY tradeDate) AS open,
       MAX(high) AS high,
       MIN(low) AS low,
       LAST(close ORDER BY tradeDate) AS close,
       SUM(volume) AS volume,
       SUM(amount) AS amount
FROM bars
WHERE symbol = $symbol
  AND tradeDate BETWEEN $startDate AND $endDate
GROUP BY symbol, name, month
ORDER BY month;

SELECT symbol,
       ANY_VALUE(name) AS name,
       COUNT(*) AS tradeCount,
       COUNT(DISTINCT tradeDate) AS tradedDays,
       AVG(netReturn) AS averageTradeReturn,
       AVG(CASE WHEN netReturn > 0 THEN 1.0 ELSE 0.0 END) AS winRate,
       AVG(netReturn) FILTER (WHERE netReturn > 0) AS averageWin,
       AVG(netReturn) FILTER (WHERE netReturn <= 0) AS averageLoss,
       AVG(netReturn) FILTER (WHERE netReturn > 0)
         / NULLIF(ABS(AVG(netReturn) FILTER (WHERE netReturn <= 0)), 0)
         AS profitLossRatio,
       EXP(SUM(LN(1 + netReturn))) - 1 AS compoundedSignalReturn,
       COUNT(*) FILTER (WHERE signalType = 'ROLLING_MOMENTUM') AS rollingMomentumTrades,
       COUNT(*) FILTER (WHERE signalType = 'TAIL_MOMENTUM') AS tailMomentumTrades
FROM intraday_trading_signals
GROUP BY symbol
ORDER BY compoundedSignalReturn DESC, tradeCount DESC, symbol;

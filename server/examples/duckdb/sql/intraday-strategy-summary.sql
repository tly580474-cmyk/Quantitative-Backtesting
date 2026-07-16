WITH daily_summary AS (
  SELECT COUNT(*) AS tradingDays,
         AVG(CASE WHEN dailyReturn > 0 THEN 1.0 ELSE 0.0 END) AS winningDayRate,
         AVG(dailyReturn) AS averageDailyReturn,
         MAX(cumulativeReturn) FILTER (
           WHERE tradeDate = (SELECT MAX(tradeDate) FROM intraday_daily_performance)
         ) AS cumulativeReturn,
         MIN(drawdown) AS maxDrawdown,
         SUM(rollingMomentumTrades) AS rollingMomentumTrades,
         SUM(tailMomentumTrades) AS tailMomentumTrades
  FROM intraday_daily_performance
),
signal_summary AS (
  SELECT COUNT(*) AS totalTrades,
         COUNT(DISTINCT symbol) AS tradedSymbols,
         AVG(grossReturn) AS averageGrossTradeReturn,
         AVG(netReturn) AS averageTradeReturn,
         AVG(CASE WHEN netReturn > 0 THEN 1.0 ELSE 0.0 END) AS tradeWinRate,
         AVG(netReturn) FILTER (WHERE netReturn > 0) AS averageWin,
         AVG(netReturn) FILTER (WHERE netReturn <= 0) AS averageLoss,
         AVG(netReturn) FILTER (WHERE netReturn > 0)
           / NULLIF(ABS(AVG(netReturn) FILTER (WHERE netReturn <= 0)), 0)
           AS profitLossRatio,
         MAX(roundTripCostBps) AS roundTripCostBps
  FROM intraday_trading_signals
)
SELECT *
FROM daily_summary
CROSS JOIN signal_summary;

CREATE OR REPLACE TEMP TABLE intraday_daily_features AS
SELECT instrumentKey,
       market,
       symbol,
       name,
       tradeDate,
       amount,
       totalMarketCap,
       floatMarketCap,
       peTtm,
       pb,
       AVG(amount) OVER (
         PARTITION BY instrumentKey
         ORDER BY tradeDate
         ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
       ) AS averageAmount20
FROM bars
WHERE tradeDate BETWEEN CAST($startDate AS DATE) - INTERVAL 60 DAY
                        AND CAST($endDate AS DATE);

CREATE OR REPLACE TEMP TABLE intraday_universe AS
WITH trading_dates AS (
  SELECT DISTINCT tradeDate
  FROM bars
  WHERE tradeDate BETWEEN CAST($startDate AS DATE) AND CAST($endDate AS DATE)
),
instruments AS (
  SELECT DISTINCT instrumentKey
  FROM intraday_daily_features
),
previous_day AS (
  SELECT date.tradeDate,
         feature.instrumentKey,
         feature.market,
         feature.symbol,
         feature.name,
         feature.tradeDate AS filterDataDate,
         feature.averageAmount20,
         feature.totalMarketCap,
         feature.floatMarketCap,
         feature.peTtm,
         feature.pb
  FROM trading_dates AS date
  CROSS JOIN instruments
  ASOF JOIN intraday_daily_features AS feature
    ON feature.instrumentKey = instruments.instrumentKey
   AND date.tradeDate > feature.tradeDate
)
SELECT *,
       CASE
         WHEN market = 'SH' THEN symbol || '.SH'
         WHEN market = 'SZ' THEN symbol || '.SZ'
         ELSE symbol || '.BJ'
       END AS minuteCode
FROM previous_day
WHERE averageAmount20 >= $minAverageAmount20
  AND totalMarketCap BETWEEN $minMarketCap AND $maxMarketCap
  AND peTtm > 0
  AND peTtm <= $maxPeTtm
  AND pb > 0
  AND pb <= $maxPb
  AND name NOT LIKE '%ST%'
  AND name NOT LIKE '%退%';

CREATE OR REPLACE TEMP TABLE intraday_minute_base AS
SELECT universe.instrumentKey,
       universe.market,
       universe.symbol,
       universe.name,
       universe.filterDataDate,
       universe.averageAmount20,
       universe.totalMarketCap,
       universe.floatMarketCap,
       universe.peTtm,
       universe.pb,
       CAST(strptime(minute.trade_time, '%Y-%m-%d %H:%M:%S') AS DATE) AS tradeDate,
       CAST(strptime(minute.trade_time, '%Y-%m-%d %H:%M:%S') AS TIMESTAMP) AS tradeTime,
       CAST(minute.open AS DOUBLE) AS open,
       CAST(minute.high AS DOUBLE) AS high,
       CAST(minute.low AS DOUBLE) AS low,
       CAST(minute.close AS DOUBLE) AS close,
       CAST(minute.vol AS BIGINT) AS volume,
       CAST(minute.amount AS DOUBLE) AS amount
FROM read_parquet([$juneGlob, $julyGlob]) AS minute
INNER JOIN intraday_universe AS universe
  ON universe.minuteCode = minute.code
 AND REPLACE(CAST(universe.tradeDate AS VARCHAR), '-', '') = CAST(minute.date AS VARCHAR)
WHERE CAST(minute.date AS VARCHAR)
      BETWEEN CAST($startCompact AS VARCHAR) AND CAST($endCompact AS VARCHAR);

CREATE OR REPLACE TEMP TABLE intraday_minute_features AS
WITH rolling AS (
  SELECT *,
       ROW_NUMBER() OVER stock_day AS minuteIndex,
       FIRST_VALUE(open) OVER stock_day_rows AS dayOpen,
       LAST_VALUE(close) OVER full_stock_day AS dayClose,
       LAG(close, 5) OVER stock_day AS closeLag5,
       LAG(close, 15) OVER stock_day AS closeLag15,
       LAG(close, 30) OVER stock_day AS closeLag30,
       MAX(high) OVER rolling_30 AS rollingHigh30,
       MIN(low) OVER rolling_30 AS rollingLow30,
       MAX(high) OVER stock_day_rows AS runningHigh,
       MIN(low) OVER stock_day_rows AS runningLow,
       MAX(
         CASE WHEN strftime(tradeTime, '%H:%M') = '14:30' THEN close END
       ) OVER (PARTITION BY instrumentKey, tradeDate) AS tailAnchorClose,
       LEAD(open, 1) OVER stock_day AS nextMinuteOpen,
       LEAD(tradeTime, 1) OVER stock_day AS nextMinuteTime,
       LEAD(close, 15) OVER stock_day AS exitClose15,
       LEAD(tradeTime, 15) OVER stock_day AS exitTime15
  FROM intraday_minute_base
  WINDOW
    stock_day AS (
      PARTITION BY instrumentKey, tradeDate ORDER BY tradeTime
    ),
    stock_day_rows AS (
      PARTITION BY instrumentKey, tradeDate
      ORDER BY tradeTime
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ),
    full_stock_day AS (
      PARTITION BY instrumentKey, tradeDate
      ORDER BY tradeTime
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ),
    rolling_30 AS (
      PARTITION BY instrumentKey, tradeDate
      ORDER BY tradeTime
      ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    )
)
SELECT *,
       close / NULLIF(closeLag5, 0) - 1 AS momentum5,
       close / NULLIF(closeLag15, 0) - 1 AS momentum15,
       close / NULLIF(closeLag30, 0) - 1 AS momentum30,
       rollingHigh30 / NULLIF(rollingLow30, 0) - 1 AS rollingAmplitude30,
       runningHigh / NULLIF(runningLow, 0) - 1 AS intradayAmplitude,
       close / NULLIF(tailAnchorClose, 0) - 1 AS tailMomentum
FROM rolling;

CREATE OR REPLACE TEMP TABLE intraday_trading_signals AS
WITH candidates AS (
  SELECT *,
         CASE
           WHEN strftime(tradeTime, '%H:%M') = '14:45'
             AND tailMomentum >= $tailMomentumThreshold
             AND momentum15 >= $momentum15Threshold
             AND momentum30 >= $momentum30Threshold
             AND rollingAmplitude30 BETWEEN $minRollingAmplitude30
                                        AND $maxRollingAmplitude30
             AND intradayAmplitude <= $maxIntradayAmplitude
             THEN 'TAIL_MOMENTUM'
           WHEN strftime(tradeTime, '%H:%M') BETWEEN '10:00' AND '14:15'
             AND minuteIndex % 15 = 0
             AND momentum5 >= $momentum5Threshold
             AND momentum15 >= $momentum15Threshold
             AND momentum30 >= $momentum30Threshold
             AND rollingAmplitude30 BETWEEN $minRollingAmplitude30
                                        AND $maxRollingAmplitude30
             AND intradayAmplitude <= $maxIntradayAmplitude
             AND DATE_DIFF('minute', tradeTime, exitTime15) <= 20
             THEN 'ROLLING_MOMENTUM'
         END AS signalType
  FROM intraday_minute_features
),
executed AS (
  SELECT *,
         nextMinuteTime AS entryTime,
         nextMinuteOpen AS entryPrice,
         CASE WHEN signalType = 'TAIL_MOMENTUM' THEN
           CAST(tradeDate AS TIMESTAMP) + INTERVAL 15 HOUR
         ELSE exitTime15 END AS exitTime,
         CASE WHEN signalType = 'TAIL_MOMENTUM' THEN dayClose
              ELSE exitClose15 END AS exitPrice,
         0.40 * momentum5
           + 0.35 * momentum15
           + 0.25 * momentum30
           + CASE WHEN signalType = 'TAIL_MOMENTUM'
                  THEN 0.20 * tailMomentum ELSE 0 END AS signalStrength
  FROM candidates
  WHERE signalType IS NOT NULL
    AND nextMinuteOpen > 0
),
one_signal_per_stock_day AS (
  SELECT *
  FROM executed
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY instrumentKey, tradeDate
    ORDER BY signalStrength DESC, tradeTime
  ) = 1
),
daily_ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY tradeDate
           ORDER BY signalStrength DESC, instrumentKey
         ) AS dailySignalRank
  FROM one_signal_per_stock_day
)
SELECT instrumentKey,
       market,
       symbol,
       name,
       tradeDate,
       signalType,
       tradeTime AS signalTime,
       entryTime,
       exitTime,
       entryPrice,
       exitPrice,
       exitPrice / NULLIF(entryPrice, 0) - 1 AS grossReturn,
       exitPrice / NULLIF(entryPrice, 0) - 1
         - CAST($roundTripCostBps AS DOUBLE) / 10000 AS netReturn,
       momentum5,
       momentum15,
       momentum30,
       rollingAmplitude30,
       intradayAmplitude,
       tailMomentum,
       signalStrength,
       dailySignalRank,
       averageAmount20,
       totalMarketCap,
       floatMarketCap,
       peTtm,
       pb,
       filterDataDate,
       CAST($roundTripCostBps AS DOUBLE) AS roundTripCostBps
FROM daily_ranked
WHERE exitPrice > 0
  AND dailySignalRank <= CAST($maxDailySignals AS INTEGER);

CREATE OR REPLACE TEMP TABLE intraday_daily_performance AS
WITH trading_dates AS (
  SELECT DISTINCT tradeDate
  FROM intraday_universe
),
daily_signal_stats AS (
  SELECT tradeDate,
         COUNT(*) AS tradeCount,
         COUNT(DISTINCT symbol) AS tradedSymbols,
         AVG(netReturn) AS dailyReturn,
         AVG(CASE WHEN netReturn > 0 THEN 1.0 ELSE 0.0 END) AS winRate,
         AVG(netReturn) FILTER (WHERE netReturn > 0) AS averageWin,
         AVG(netReturn) FILTER (WHERE netReturn <= 0) AS averageLoss,
         COUNT(*) FILTER (WHERE signalType = 'ROLLING_MOMENTUM') AS rollingMomentumTrades,
         COUNT(*) FILTER (WHERE signalType = 'TAIL_MOMENTUM') AS tailMomentumTrades
  FROM intraday_trading_signals
  GROUP BY tradeDate
),
daily AS (
  SELECT dates.tradeDate,
         COALESCE(stats.tradeCount, 0) AS tradeCount,
         COALESCE(stats.tradedSymbols, 0) AS tradedSymbols,
         COALESCE(stats.dailyReturn, 0) AS dailyReturn,
         stats.winRate,
         stats.averageWin,
         stats.averageLoss,
         stats.averageWin / NULLIF(ABS(stats.averageLoss), 0) AS profitLossRatio,
         COALESCE(stats.rollingMomentumTrades, 0) AS rollingMomentumTrades,
         COALESCE(stats.tailMomentumTrades, 0) AS tailMomentumTrades
  FROM trading_dates AS dates
  LEFT JOIN daily_signal_stats AS stats USING (tradeDate)
),
curve AS (
  SELECT *,
         EXP(SUM(LN(1 + dailyReturn)) OVER (ORDER BY tradeDate)) AS nav
  FROM daily
)
SELECT *,
       nav - 1 AS cumulativeReturn,
       nav / MAX(nav) OVER (
         ORDER BY tradeDate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) - 1 AS drawdown
FROM curve
ORDER BY tradeDate;

SELECT COUNT(*) AS signalRows,
       COUNT(DISTINCT symbol) AS signalSymbols,
       COUNT(DISTINCT tradeDate) AS signalDays
FROM intraday_trading_signals;

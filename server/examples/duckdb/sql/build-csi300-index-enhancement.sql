CREATE OR REPLACE TEMP TABLE csi300_benchmark_base AS
WITH selected_snapshot AS (
  SELECT snapshotId
  FROM index_constituent_snapshots
  WHERE indexCode = $indexCode
    AND weightDate IS NOT NULL
    AND weightDate <= CAST($rebalanceDate AS DATE)
  ORDER BY weightDate DESC, constituentDate DESC, snapshotId DESC
  LIMIT 1
),
members AS (
  SELECT member.instrumentKey,
         member.constituentCode AS symbol,
         member.constituentName AS name,
         member.exchange,
         member.weightPct
  FROM index_constituents AS member
  INNER JOIN selected_snapshot USING (snapshotId)
  WHERE member.indexCode = $indexCode
    AND member.weightPct IS NOT NULL
)
SELECT *,
       weightPct * 100.0 / SUM(weightPct) OVER () AS benchmarkWeightPct,
       CASE
         WHEN exchange = '上海证券交易所' OR symbol LIKE '6%' THEN symbol || '.SH'
         ELSE symbol || '.SZ'
       END AS minuteCode
FROM members;

CREATE OR REPLACE TEMP TABLE csi300_adjusted_daily AS
SELECT bar.instrumentKey,
       bar.market,
       bar.symbol,
       bar.name,
       bar.tradeDate,
       bar.peTtm,
       bar.pb,
       bar.amount,
       bar.open * COALESCE(factor.factor, 1) + COALESCE(factor.priceOffset, 0)
         AS adjustedOpen,
       bar.close * COALESCE(factor.factor, 1) + COALESCE(factor.priceOffset, 0)
         AS adjustedClose,
       factor.factorVersion
FROM bars AS bar
INNER JOIN csi300_benchmark_base AS member USING (instrumentKey)
ASOF LEFT JOIN adjustment_factors AS factor
  ON bar.instrumentKey = factor.instrumentKey
 AND bar.tradeDate >= factor.effectiveDate
WHERE bar.tradeDate BETWEEN CAST($rebalanceDate AS DATE) - INTERVAL 220 DAY
                        AND CAST($endDate AS DATE);

CREATE OR REPLACE TEMP TABLE csi300_alpha_features AS
WITH daily AS (
  SELECT *,
         adjustedClose / NULLIF(LAG(adjustedClose) OVER instrument_window, 0) - 1
           AS dailyReturn,
         LAG(adjustedClose, 20) OVER instrument_window AS adjustedCloseLag20,
         LAG(adjustedClose, 120) OVER instrument_window AS adjustedCloseLag120
  FROM csi300_adjusted_daily
  WINDOW instrument_window AS (
    PARTITION BY instrumentKey ORDER BY tradeDate
  )
),
feature_window AS (
  SELECT *,
         STDDEV_SAMP(dailyReturn) OVER (
           PARTITION BY instrumentKey
           ORDER BY tradeDate
           ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
         ) AS volatility20
  FROM daily
),
snapshot AS (
  SELECT feature.instrumentKey,
         feature.market,
         feature.symbol,
         feature.name,
         feature.tradeDate AS rebalanceDate,
         member.benchmarkWeightPct,
         member.minuteCode,
         feature.peTtm,
         feature.pb,
         1.0 / NULLIF(feature.peTtm, 0) AS earningsYield,
         1.0 / NULLIF(feature.pb, 0) AS bookYield,
         feature.adjustedCloseLag20 / NULLIF(feature.adjustedCloseLag120, 0) - 1
           AS momentum120m20,
         feature.volatility20,
         feature.factorVersion,
         industry.level1Code,
         industry.level1Name
  FROM feature_window AS feature
  INNER JOIN csi300_benchmark_base AS member USING (instrumentKey)
  LEFT JOIN sw_industry_memberships AS industry
    ON industry.instrumentKey = feature.instrumentKey
   AND CAST($rebalanceDate AS TIMESTAMP) >= industry.effectiveFrom
   AND (
     industry.effectiveTo IS NULL
     OR CAST($rebalanceDate AS TIMESTAMP) <= industry.effectiveTo
   )
  WHERE feature.tradeDate <= CAST($rebalanceDate AS DATE)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY feature.instrumentKey ORDER BY feature.tradeDate DESC
  ) = 1
),
ranked AS (
  SELECT *,
         PERCENT_RANK() OVER (
           PARTITION BY level1Code ORDER BY earningsYield
         ) * 2 - 1 AS earningsYieldScore,
         PERCENT_RANK() OVER (
           PARTITION BY level1Code ORDER BY bookYield
         ) * 2 - 1 AS bookYieldScore,
         PERCENT_RANK() OVER (
           PARTITION BY level1Code ORDER BY momentum120m20
         ) * 2 - 1 AS momentumScore,
         1 - PERCENT_RANK() OVER (
           PARTITION BY level1Code ORDER BY volatility20
         ) * 2 AS lowVolatilityScore
  FROM snapshot
)
SELECT *,
       (earningsYieldScore + bookYieldScore) / 2 AS valueScore,
       0.35 * ((earningsYieldScore + bookYieldScore) / 2)
         + 0.40 * momentumScore
         + 0.25 * lowVolatilityScore AS alphaScore
FROM ranked;

CREATE OR REPLACE TEMP TABLE csi300_target_portfolio AS
WITH raw_target AS (
  SELECT *,
         benchmarkWeightPct * EXP(CAST($tiltStrength AS DOUBLE) * alphaScore)
           AS rawTargetWeight
  FROM csi300_alpha_features
)
SELECT *,
       rawTargetWeight * 100.0 / SUM(rawTargetWeight) OVER () AS targetWeightPct,
       rawTargetWeight * 100.0 / SUM(rawTargetWeight) OVER () - benchmarkWeightPct
         AS activeWeightPct
FROM raw_target;

CREATE OR REPLACE TEMP TABLE csi300_period_path AS
WITH trading_dates AS (
  SELECT tradeDate
  FROM index_bars
  WHERE indexCode = $indexCode
    AND tradeDate BETWEEN CAST($startDate AS DATE) AND CAST($endDate AS DATE)
),
start_prices AS (
  SELECT instrumentKey,
         adjustedOpen AS periodStartAdjustedOpen
  FROM csi300_adjusted_daily
  WHERE tradeDate = CAST($startDate AS DATE)
),
grid AS (
  SELECT target.instrumentKey,
         dates.tradeDate
  FROM csi300_target_portfolio AS target
  CROSS JOIN trading_dates AS dates
),
path AS (
  SELECT grid.instrumentKey,
         grid.tradeDate,
         daily.adjustedClose,
         start.periodStartAdjustedOpen,
         daily.adjustedClose / NULLIF(start.periodStartAdjustedOpen, 0) AS periodGrossReturn
  FROM grid
  ASOF LEFT JOIN csi300_adjusted_daily AS daily
    ON grid.instrumentKey = daily.instrumentKey
   AND grid.tradeDate >= daily.tradeDate
  INNER JOIN start_prices AS start
    ON start.instrumentKey = grid.instrumentKey
)
SELECT path.*,
       target.symbol,
       target.name,
       target.level1Code,
       target.level1Name,
       target.benchmarkWeightPct,
       target.targetWeightPct,
       target.activeWeightPct,
       target.factorVersion
FROM path
INNER JOIN csi300_target_portfolio AS target USING (instrumentKey);

CREATE OR REPLACE TEMP TABLE csi300_weight_deviation AS
WITH drifted AS (
  SELECT *,
         benchmarkWeightPct * periodGrossReturn
           / SUM(benchmarkWeightPct * periodGrossReturn) OVER (PARTITION BY tradeDate) * 100
           AS dynamicBenchmarkWeightPct,
         targetWeightPct * periodGrossReturn
           / SUM(targetWeightPct * periodGrossReturn) OVER (PARTITION BY tradeDate) * 100
           AS dynamicTargetWeightPct
  FROM csi300_period_path
)
SELECT *,
       dynamicTargetWeightPct - dynamicBenchmarkWeightPct AS dynamicActiveWeightPct,
       ABS(dynamicTargetWeightPct - dynamicBenchmarkWeightPct) AS absoluteActiveWeightPct
FROM drifted;

CREATE OR REPLACE TEMP TABLE csi300_daily_performance AS
WITH official_index AS (
  SELECT tradeDate,
         open,
         close,
         FIRST_VALUE(open) OVER (ORDER BY tradeDate) AS periodStartOpen
  FROM index_bars
  WHERE indexCode = $indexCode
    AND tradeDate BETWEEN CAST($startDate AS DATE) AND CAST($endDate AS DATE)
),
portfolio AS (
  SELECT tradeDate,
         SUM(targetWeightPct / 100 * periodGrossReturn) - 1 AS enhancedCumulativeReturn,
         SUM(benchmarkWeightPct / 100 * periodGrossReturn) - 1
           AS constituentBenchmarkCumulativeReturn,
         0.5 * SUM(absoluteActiveWeightPct) / 100 AS activeShare
  FROM csi300_weight_deviation
  GROUP BY tradeDate
)
SELECT portfolio.tradeDate,
       portfolio.enhancedCumulativeReturn,
       portfolio.constituentBenchmarkCumulativeReturn,
       official.close / NULLIF(official.periodStartOpen, 0) - 1 AS officialIndexCumulativeReturn,
       portfolio.enhancedCumulativeReturn
         - portfolio.constituentBenchmarkCumulativeReturn
         AS constituentExcessReturn,
       portfolio.enhancedCumulativeReturn
         - (official.close / NULLIF(official.periodStartOpen, 0) - 1)
         AS officialIndexExcessReturn,
       portfolio.activeShare
FROM portfolio
INNER JOIN official_index AS official USING (tradeDate)
ORDER BY portfolio.tradeDate;

CREATE OR REPLACE TEMP TABLE csi300_day_start_weights AS
WITH dates AS (
  SELECT DISTINCT tradeDate
  FROM csi300_weight_deviation
),
weights AS (
  SELECT deviation.*,
         LAG(dynamicBenchmarkWeightPct) OVER (
           PARTITION BY instrumentKey ORDER BY tradeDate
         ) AS previousBenchmarkWeightPct,
         LAG(dynamicTargetWeightPct) OVER (
           PARTITION BY instrumentKey ORDER BY tradeDate
         ) AS previousTargetWeightPct
  FROM csi300_weight_deviation AS deviation
)
SELECT weights.tradeDate,
       weights.instrumentKey,
       weights.symbol,
       target.minuteCode,
       COALESCE(weights.previousBenchmarkWeightPct, weights.benchmarkWeightPct)
         AS dayStartBenchmarkWeightPct,
       COALESCE(weights.previousTargetWeightPct, weights.targetWeightPct)
         AS dayStartTargetWeightPct
FROM weights
INNER JOIN csi300_target_portfolio AS target USING (instrumentKey);

CREATE OR REPLACE TEMP TABLE csi300_minute_excess_detail AS
WITH minute_source AS (
  SELECT code,
         CAST(strptime(trade_time, '%Y-%m-%d %H:%M:%S') AS TIMESTAMP) AS tradeTime,
         CAST(strptime(trade_time, '%Y-%m-%d %H:%M:%S') AS DATE) AS tradeDate,
         CAST(open AS DOUBLE) AS open,
         CAST(close AS DOUBLE) AS close
  FROM read_parquet($minuteGlob)
  WHERE date BETWEEN REPLACE($startDate, '-', '') AND REPLACE($endDate, '-', '')
    AND code IN (SELECT minuteCode FROM csi300_target_portfolio)
),
minute_returns AS (
  SELECT *,
         close / NULLIF(
           COALESCE(
             LAG(close) OVER (PARTITION BY code, tradeDate ORDER BY tradeTime),
             open
           ),
           0
         ) - 1 AS minuteReturn
  FROM minute_source
)
SELECT minute.tradeDate,
       minute.tradeTime,
       strftime(minute.tradeTime, '%H:%M') AS minuteOfDay,
       weights.symbol,
       target.name,
       target.level1Code,
       target.level1Name,
       weights.dayStartBenchmarkWeightPct,
       weights.dayStartTargetWeightPct,
       weights.dayStartTargetWeightPct - weights.dayStartBenchmarkWeightPct
         AS dayStartActiveWeightPct,
       minute.minuteReturn,
       weights.dayStartBenchmarkWeightPct / 100 * minute.minuteReturn
         AS benchmarkContribution,
       weights.dayStartTargetWeightPct / 100 * minute.minuteReturn
         AS enhancedContribution,
       (
         weights.dayStartTargetWeightPct - weights.dayStartBenchmarkWeightPct
       ) / 100 * minute.minuteReturn AS excessContribution
FROM minute_returns AS minute
INNER JOIN csi300_day_start_weights AS weights
  ON weights.tradeDate = minute.tradeDate
 AND weights.minuteCode = minute.code
INNER JOIN csi300_target_portfolio AS target USING (symbol);

CREATE OR REPLACE TEMP TABLE csi300_intraday_excess_by_minute AS
WITH minute_total AS (
  SELECT tradeDate,
         tradeTime,
         minuteOfDay,
         COUNT(*) AS coveredStocks,
         SUM(benchmarkContribution) AS benchmarkContribution,
         SUM(enhancedContribution) AS enhancedContribution,
         SUM(excessContribution) AS excessContribution
  FROM csi300_minute_excess_detail
  GROUP BY tradeDate, tradeTime, minuteOfDay
)
SELECT *,
       SUM(excessContribution) OVER (
         PARTITION BY tradeDate ORDER BY tradeTime
       ) AS cumulativeIntradayExcessContribution
FROM minute_total
ORDER BY tradeDate, tradeTime;

SELECT COUNT(*) AS constituents,
       MIN(tradeDate) AS firstPerformanceDate,
       MAX(tradeDate) AS lastPerformanceDate,
       (SELECT COUNT(*) FROM csi300_minute_excess_detail) AS minuteDetailRows
FROM csi300_period_path;

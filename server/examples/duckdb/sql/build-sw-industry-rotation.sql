SELECT CASE
  WHEN CAST($topIndustries AS INTEGER) < 1 THEN error('topIndustries 必须大于 0')
  WHEN CAST($maxIndustryWeight AS DOUBLE) < 1.0 / CAST($topIndustries AS DOUBLE)
    THEN error('maxIndustryWeight 不能低于等权权重 1/topIndustries')
  WHEN CAST($maxIndustryWeight AS DOUBLE) > 1
    THEN error('maxIndustryWeight 不能大于 1')
  ELSE true
END AS parameterCheck;

CREATE OR REPLACE TEMP TABLE sw_rotation_calendar AS
WITH trading_dates AS (
  SELECT DISTINCT tradeDate
  FROM sw_industry_bars
  WHERE tradeDate BETWEEN CAST($startDate AS DATE)
                          AND CAST($endDate AS DATE) + INTERVAL 3 MONTH
),
signal_months AS (
  SELECT CAST(DATE_TRUNC('month', tradeDate) AS DATE) AS signalMonth,
         MAX(tradeDate) AS signalDate
  FROM trading_dates
  WHERE tradeDate BETWEEN CAST($startDate AS DATE) AND CAST($endDate AS DATE)
  GROUP BY 1
)
SELECT signalMonth,
       signalDate,
       (
         SELECT MIN(tradeDate)
         FROM trading_dates
         WHERE tradeDate >= signalMonth + INTERVAL 1 MONTH
       ) AS entryDate,
       (
         SELECT MIN(tradeDate)
         FROM trading_dates
         WHERE tradeDate >= signalMonth + INTERVAL 2 MONTH
       ) AS exitDate
FROM signal_months
ORDER BY signalMonth;

CREATE OR REPLACE TEMP TABLE sw_industry_market_features AS
WITH daily AS (
  SELECT taxonomyKey,
         indexCode,
         industryCode,
         industryName,
         tradeDate,
         open,
         close,
         LAG(close, 63) OVER industry_window AS closeLag63,
         LAG(close, 126) OVER industry_window AS closeLag126
  FROM sw_industry_bars
  WINDOW industry_window AS (
    PARTITION BY indexCode ORDER BY tradeDate
  )
),
signal AS (
  SELECT calendar.signalMonth,
         calendar.signalDate,
         calendar.entryDate,
         calendar.exitDate,
         daily.taxonomyKey,
         daily.indexCode,
         daily.industryCode,
         daily.industryName,
         daily.close AS signalClose,
         daily.close / NULLIF(daily.closeLag63, 0) - 1 AS momentum3m,
         daily.close / NULLIF(daily.closeLag126, 0) - 1 AS momentum6m
  FROM sw_rotation_calendar AS calendar
  INNER JOIN daily ON daily.tradeDate = calendar.signalDate
  WHERE daily.closeLag63 IS NOT NULL
    AND daily.closeLag126 IS NOT NULL
)
SELECT signal.*,
       entry.open AS entryOpen,
       exit.open AS exitOpen,
       exit.open / NULLIF(entry.open, 0) - 1 AS monthlyIndustryReturn
FROM signal
INNER JOIN sw_industry_bars AS entry
  ON entry.indexCode = signal.indexCode
 AND entry.tradeDate = signal.entryDate
INNER JOIN sw_industry_bars AS exit
  ON exit.indexCode = signal.indexCode
 AND exit.tradeDate = signal.exitDate;

CREATE OR REPLACE TEMP TABLE sw_industry_valuation_snapshot AS
WITH stock_snapshot AS (
  SELECT calendar.signalMonth,
         calendar.signalDate,
         membership.level1IndexCode AS indexCode,
         membership.level1Code AS industryCode,
         membership.level1Name AS industryName,
         bar.instrumentKey,
         bar.symbol,
         bar.close,
         bar.totalMarketCap,
         bar.peTtm,
         bar.pb
  FROM sw_rotation_calendar AS calendar
  INNER JOIN bars AS bar ON bar.tradeDate = calendar.signalDate
  INNER JOIN sw_industry_memberships AS membership
    ON membership.instrumentKey = bar.instrumentKey
   AND CAST(calendar.signalDate AS TIMESTAMP) >= membership.effectiveFrom
   AND (
     membership.effectiveTo IS NULL
     OR CAST(calendar.signalDate AS TIMESTAMP) <= membership.effectiveTo
   )
  WHERE bar.totalMarketCap > 0
    AND bar.close > 0
),
dividends AS (
  SELECT snapshot.signalMonth,
         snapshot.instrumentKey,
         SUM(dividend.cashDividendPerShare) AS trailingCashDividendPerShare,
         COUNT(dividend.eventId) AS trailingDividendEvents
  FROM stock_snapshot AS snapshot
  LEFT JOIN dividend_events AS dividend
    ON dividend.instrumentKey = snapshot.instrumentKey
   AND dividend.exDate > snapshot.signalDate - INTERVAL 365 DAY
   AND dividend.exDate <= snapshot.signalDate
   AND dividend.cashDividendPerShare > 0
  GROUP BY snapshot.signalMonth, snapshot.instrumentKey
),
stock_metrics AS (
  SELECT snapshot.*,
         COALESCE(dividends.trailingCashDividendPerShare, 0)
           / NULLIF(snapshot.close, 0) AS trailingDividendYield,
         COALESCE(dividends.trailingDividendEvents, 0) AS trailingDividendEvents
  FROM stock_snapshot AS snapshot
  LEFT JOIN dividends USING (signalMonth, instrumentKey)
)
SELECT signalMonth,
       MAX(signalDate) AS signalDate,
       indexCode,
       ANY_VALUE(industryCode) AS industryCode,
       ANY_VALUE(industryName) AS industryName,
       COUNT(*) AS stockCount,
       COUNT(*) FILTER (WHERE peTtm > 0) AS validPeCount,
       COUNT(*) FILTER (WHERE pb > 0) AS validPbCount,
       COUNT(*) FILTER (WHERE trailingDividendEvents > 0) AS dividendStockCount,
       SUM(totalMarketCap) AS industryMarketCap,
       SUM(totalMarketCap) FILTER (WHERE peTtm > 0)
         / NULLIF(SUM(totalMarketCap / peTtm) FILTER (WHERE peTtm > 0), 0)
         AS weightedPe,
       SUM(totalMarketCap) FILTER (WHERE pb > 0)
         / NULLIF(SUM(totalMarketCap / pb) FILTER (WHERE pb > 0), 0)
         AS weightedPb,
       SUM(totalMarketCap * trailingDividendYield)
         / NULLIF(SUM(totalMarketCap), 0) AS weightedDividendYield
FROM stock_metrics
GROUP BY signalMonth, indexCode;

CREATE OR REPLACE TEMP TABLE sw_industry_rotation_scores AS
WITH combined AS (
  SELECT market.*,
         valuation.stockCount,
         valuation.validPeCount,
         valuation.validPbCount,
         valuation.dividendStockCount,
         valuation.industryMarketCap,
         valuation.weightedPe,
         valuation.weightedPb,
         valuation.weightedDividendYield
  FROM sw_industry_market_features AS market
  INNER JOIN sw_industry_valuation_snapshot AS valuation
    ON valuation.signalMonth = market.signalMonth
   AND valuation.indexCode = market.indexCode
),
percentiles AS (
  SELECT *,
         CASE WHEN momentum3m IS NULL THEN 0.5 ELSE
           PERCENT_RANK() OVER (
             PARTITION BY signalMonth ORDER BY momentum3m
           )
         END AS momentum3Percentile,
         CASE WHEN momentum6m IS NULL THEN 0.5 ELSE
           PERCENT_RANK() OVER (
             PARTITION BY signalMonth ORDER BY momentum6m
           )
         END AS momentum6Percentile,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth ORDER BY weightedPe
         ) AS pePercentile,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth ORDER BY weightedPb
         ) AS pbPercentile,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth ORDER BY weightedDividendYield
         ) AS dividendYieldPercentile
  FROM combined
  WHERE weightedPe > 0
    AND weightedPb > 0
    AND industryMarketCap > 0
)
SELECT *,
       1 - pePercentile AS peValueScore,
       1 - pbPercentile AS pbValueScore,
       $momentum3Weight * momentum3Percentile
         + $momentum6Weight * momentum6Percentile
         + $peWeight * (1 - pePercentile)
         + $pbWeight * (1 - pbPercentile)
         + $dividendWeight * dividendYieldPercentile AS compositeScore,
       ROW_NUMBER() OVER (
         PARTITION BY signalMonth
         ORDER BY (
           $momentum3Weight * momentum3Percentile
           + $momentum6Weight * momentum6Percentile
           + $peWeight * (1 - pePercentile)
           + $pbWeight * (1 - pbPercentile)
           + $dividendWeight * dividendYieldPercentile
         ) DESC,
         indexCode
       ) AS rotationRank
FROM percentiles;

CREATE OR REPLACE TEMP TABLE sw_industry_rotation_selection AS
WITH selected AS (
  SELECT *
  FROM sw_industry_rotation_scores
  WHERE rotationRank <= CAST($topIndustries AS INTEGER)
),
raw_weights AS (
  SELECT *,
         1.0 / COUNT(*) OVER (PARTITION BY signalMonth) AS equalWeight,
         industryMarketCap
           / SUM(industryMarketCap) OVER (PARTITION BY signalMonth) AS rawMarketCapWeight
  FROM selected
),
weight_limits AS (
  SELECT *,
         MAX(rawMarketCapWeight) OVER (PARTITION BY signalMonth) AS maxRawMarketCapWeight
  FROM raw_weights
)
SELECT *,
       equalWeight
         + LEAST(
             1.0,
             CASE
               WHEN maxRawMarketCapWeight <= equalWeight THEN 1.0
               ELSE GREATEST(
                 0.0,
                 (CAST($maxIndustryWeight AS DOUBLE) - equalWeight)
                   / (maxRawMarketCapWeight - equalWeight)
               )
             END
           ) * (rawMarketCapWeight - equalWeight) AS marketCapWeight
FROM weight_limits;

CREATE OR REPLACE TEMP TABLE sw_industry_rotation_changes AS
WITH month_pairs AS (
  SELECT signalMonth,
         LAG(signalMonth) OVER (ORDER BY signalMonth) AS previousSignalMonth
  FROM sw_rotation_calendar
),
current_and_previous AS (
  SELECT pair.signalMonth,
         pair.previousSignalMonth,
         current.indexCode,
         current.industryName,
         previous.rotationRank AS previousRank,
         current.rotationRank AS currentRank,
         COALESCE(previous.equalWeight, 0) AS previousEqualWeight,
         COALESCE(current.equalWeight, 0) AS currentEqualWeight,
         COALESCE(previous.marketCapWeight, 0) AS previousMarketCapWeight,
         COALESCE(current.marketCapWeight, 0) AS currentMarketCapWeight
  FROM month_pairs AS pair
  INNER JOIN sw_industry_rotation_selection AS current
    ON current.signalMonth = pair.signalMonth
  LEFT JOIN sw_industry_rotation_selection AS previous
    ON previous.signalMonth = pair.previousSignalMonth
   AND previous.indexCode = current.indexCode
  UNION ALL
  SELECT pair.signalMonth,
         pair.previousSignalMonth,
         previous.indexCode,
         previous.industryName,
         previous.rotationRank AS previousRank,
         NULL AS currentRank,
         previous.equalWeight AS previousEqualWeight,
         0 AS currentEqualWeight,
         previous.marketCapWeight AS previousMarketCapWeight,
         0 AS currentMarketCapWeight
  FROM month_pairs AS pair
  INNER JOIN sw_industry_rotation_selection AS previous
    ON previous.signalMonth = pair.previousSignalMonth
  LEFT JOIN sw_industry_rotation_selection AS current
    ON current.signalMonth = pair.signalMonth
   AND current.indexCode = previous.indexCode
  WHERE current.indexCode IS NULL
)
SELECT *,
       CASE
         WHEN previousRank IS NULL THEN 'ADD'
         WHEN currentRank IS NULL THEN 'REMOVE'
         WHEN ABS(currentMarketCapWeight - previousMarketCapWeight) > 0.000001 THEN 'REWEIGHT'
         ELSE 'HOLD'
       END AS action
FROM current_and_previous;

CREATE OR REPLACE TEMP TABLE sw_industry_rotation_portfolio AS
WITH monthly_returns AS (
  SELECT signalMonth,
         MAX(signalDate) AS signalDate,
         MAX(entryDate) AS entryDate,
         MAX(exitDate) AS exitDate,
         SUM(equalWeight * monthlyIndustryReturn) AS equalWeightReturn,
         SUM(marketCapWeight * monthlyIndustryReturn) AS marketCapWeightReturn
  FROM sw_industry_rotation_selection
  GROUP BY signalMonth
),
turnover AS (
  SELECT signalMonth,
         CASE WHEN previousSignalMonth IS NULL THEN NULL
              ELSE 0.5 * SUM(ABS(currentEqualWeight - previousEqualWeight)) END
           AS equalWeightTurnover,
         CASE WHEN previousSignalMonth IS NULL THEN NULL
              ELSE 0.5 * SUM(ABS(currentMarketCapWeight - previousMarketCapWeight)) END
           AS marketCapWeightTurnover
  FROM sw_industry_rotation_changes
  GROUP BY signalMonth, previousSignalMonth
),
monthly AS (
  SELECT returns.*,
         turnover.equalWeightTurnover,
         turnover.marketCapWeightTurnover
  FROM monthly_returns AS returns
  INNER JOIN turnover USING (signalMonth)
)
SELECT *,
       EXP(SUM(LN(1 + equalWeightReturn)) OVER (ORDER BY signalMonth)) - 1
         AS equalWeightCumulativeReturn,
       EXP(SUM(LN(1 + marketCapWeightReturn)) OVER (ORDER BY signalMonth)) - 1
         AS marketCapWeightCumulativeReturn
FROM monthly
ORDER BY signalMonth;

SELECT COUNT(*) AS months,
       COUNT(DISTINCT indexCode) AS industries,
       COUNT(*) FILTER (WHERE rotationRank <= CAST($topIndustries AS INTEGER))
         AS selectedIndustryMonths
FROM sw_industry_rotation_scores;

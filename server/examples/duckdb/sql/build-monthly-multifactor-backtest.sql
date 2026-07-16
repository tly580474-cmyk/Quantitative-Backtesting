CREATE OR REPLACE TEMP TABLE multifactor_calendar AS
WITH trading_dates AS (
  SELECT DISTINCT tradeDate
  FROM bars
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

CREATE OR REPLACE TEMP TABLE multifactor_adjusted_daily AS
SELECT bar.instrumentKey,
       bar.market,
       bar.symbol,
       bar.name,
       bar.tradeDate,
       bar.amount,
       bar.peTtm,
       bar.pb,
       bar.open * COALESCE(factor.factor, 1) + COALESCE(factor.priceOffset, 0) AS adjustedOpen,
       bar.close * COALESCE(factor.factor, 1) + COALESCE(factor.priceOffset, 0) AS adjustedClose,
       factor.factorVersion
FROM bars AS bar
ASOF LEFT JOIN adjustment_factors AS factor
  ON bar.instrumentKey = factor.instrumentKey
 AND bar.tradeDate >= factor.effectiveDate
WHERE bar.tradeDate BETWEEN CAST($startDate AS DATE) - INTERVAL 420 DAY
                        AND CAST($endDate AS DATE) + INTERVAL 3 MONTH
  AND (
    (bar.market = 'SH' AND REGEXP_MATCHES(bar.symbol, '^(600|601|603|605|688)[0-9]{3}$'))
    OR (bar.market = 'SZ' AND REGEXP_MATCHES(bar.symbol, '^(000|001|002|003|300|301)[0-9]{3}$'))
    OR (bar.market = 'BJ' AND REGEXP_MATCHES(bar.symbol, '^[489][0-9]{5}$'))
  );

CREATE OR REPLACE TEMP TABLE multifactor_daily_features AS
SELECT *,
       ROW_NUMBER() OVER instrument_window AS listedTradingDays,
       AVG(amount) OVER (
         PARTITION BY instrumentKey
         ORDER BY tradeDate
         ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
       ) AS averageAmount20,
       LAG(adjustedClose, 21) OVER instrument_window AS adjustedCloseLag21,
       LAG(adjustedClose, 252) OVER instrument_window AS adjustedCloseLag252
FROM multifactor_adjusted_daily
WINDOW instrument_window AS (
  PARTITION BY instrumentKey ORDER BY tradeDate
);

CREATE OR REPLACE TEMP TABLE multifactor_raw AS
WITH signal_snapshot AS (
  SELECT calendar.signalMonth,
         calendar.signalDate,
         calendar.entryDate,
         calendar.exitDate,
         daily.instrumentKey,
         daily.market,
         daily.symbol,
         daily.name,
         daily.listedTradingDays,
         daily.averageAmount20,
         daily.peTtm,
         daily.pb,
         daily.adjustedClose AS signalAdjustedClose,
         daily.adjustedCloseLag21,
         daily.adjustedCloseLag252,
         daily.factorVersion,
         industry.level1Code,
         industry.level1Name
  FROM multifactor_calendar AS calendar
  INNER JOIN multifactor_daily_features AS daily
    ON daily.tradeDate = calendar.signalDate
  LEFT JOIN sw_industry_memberships AS industry
    ON industry.instrumentKey = daily.instrumentKey
   AND CAST(calendar.signalDate AS TIMESTAMP) >= industry.effectiveFrom
   AND (
     industry.effectiveTo IS NULL
     OR CAST(calendar.signalDate AS TIMESTAMP) <= industry.effectiveTo
   )
),
dividends AS (
  SELECT snapshot.signalMonth,
         snapshot.instrumentKey,
         SUM(dividend.cashDividendPerShare) AS trailingCashDividendPerShare,
         COUNT(dividend.eventId) AS trailingDividendEventCount
  FROM signal_snapshot AS snapshot
  LEFT JOIN dividend_events AS dividend
    ON dividend.instrumentKey = snapshot.instrumentKey
   AND dividend.exDate > snapshot.signalDate - INTERVAL 365 DAY
   AND dividend.exDate <= snapshot.signalDate
   AND dividend.cashDividendPerShare > 0
  GROUP BY snapshot.signalMonth, snapshot.instrumentKey
)
SELECT snapshot.*,
       entry.adjustedOpen AS entryAdjustedOpen,
       exit.adjustedOpen AS exitAdjustedOpen,
       dividends.trailingDividendEventCount,
       COALESCE(dividends.trailingCashDividendPerShare, 0) AS trailingCashDividendPerShare,
       1.0 / NULLIF(snapshot.peTtm, 0) AS earningsYield,
       1.0 / NULLIF(snapshot.pb, 0) AS bookYield,
       snapshot.adjustedCloseLag21 / NULLIF(snapshot.adjustedCloseLag252, 0) - 1 AS momentum12m1m,
       COALESCE(dividends.trailingCashDividendPerShare, 0)
         / NULLIF(snapshot.signalAdjustedClose, 0) AS trailingDividendYield,
       exit.adjustedOpen / NULLIF(entry.adjustedOpen, 0) - 1 AS adjustedMonthlyReturn
FROM signal_snapshot AS snapshot
LEFT JOIN dividends
  ON dividends.signalMonth = snapshot.signalMonth
 AND dividends.instrumentKey = snapshot.instrumentKey
LEFT JOIN multifactor_adjusted_daily AS entry
  ON entry.instrumentKey = snapshot.instrumentKey
 AND entry.tradeDate = snapshot.entryDate
LEFT JOIN multifactor_adjusted_daily AS exit
  ON exit.instrumentKey = snapshot.instrumentKey
 AND exit.tradeDate = snapshot.exitDate;

CREATE OR REPLACE TEMP TABLE multifactor_eligible AS
SELECT *
FROM multifactor_raw
WHERE listedTradingDays >= 252
  AND averageAmount20 >= $minAmount
  AND peTtm > 0
  AND pb > 0
  AND adjustedCloseLag21 > 0
  AND adjustedCloseLag252 > 0
  AND entryAdjustedOpen > 0
  AND exitAdjustedOpen > 0
  AND level1Code IS NOT NULL
  AND name NOT LIKE '%ST%'
  AND name NOT LIKE '%退%';

CREATE OR REPLACE TEMP TABLE multifactor_winsorized AS
WITH bounded AS (
  SELECT *,
         QUANTILE_CONT(earningsYield, 0.05) OVER industry_month AS earningsYieldP05,
         QUANTILE_CONT(earningsYield, 0.95) OVER industry_month AS earningsYieldP95,
         QUANTILE_CONT(bookYield, 0.05) OVER industry_month AS bookYieldP05,
         QUANTILE_CONT(bookYield, 0.95) OVER industry_month AS bookYieldP95,
         QUANTILE_CONT(momentum12m1m, 0.05) OVER industry_month AS momentumP05,
         QUANTILE_CONT(momentum12m1m, 0.95) OVER industry_month AS momentumP95,
         QUANTILE_CONT(trailingDividendYield, 0.05) OVER industry_month AS dividendYieldP05,
         QUANTILE_CONT(trailingDividendYield, 0.95) OVER industry_month AS dividendYieldP95,
         COUNT(*) OVER industry_month AS industrySampleCount
  FROM multifactor_eligible
  WINDOW industry_month AS (
    PARTITION BY signalMonth, level1Code
  )
)
SELECT *,
       LEAST(GREATEST(earningsYield, earningsYieldP05), earningsYieldP95)
         AS earningsYieldWinsorized,
       LEAST(GREATEST(bookYield, bookYieldP05), bookYieldP95)
         AS bookYieldWinsorized,
       LEAST(GREATEST(momentum12m1m, momentumP05), momentumP95)
         AS momentumWinsorized,
       LEAST(GREATEST(trailingDividendYield, dividendYieldP05), dividendYieldP95)
         AS dividendYieldWinsorized
FROM bounded
WHERE industrySampleCount >= 5;

CREATE OR REPLACE TEMP TABLE multifactor_neutralized AS
WITH industry_ranks AS (
  SELECT *,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth, level1Code
           ORDER BY earningsYieldWinsorized
         ) * 2 - 1 AS earningsYieldNeutralScore,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth, level1Code
           ORDER BY bookYieldWinsorized
         ) * 2 - 1 AS bookYieldNeutralScore,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth, level1Code
           ORDER BY momentumWinsorized
         ) * 2 - 1 AS momentumNeutralScore,
         PERCENT_RANK() OVER (
           PARTITION BY signalMonth, level1Code
           ORDER BY dividendYieldWinsorized
         ) * 2 - 1 AS dividendNeutralScore
  FROM multifactor_winsorized
)
SELECT *,
       (earningsYieldNeutralScore + bookYieldNeutralScore) / 2 AS valueScore,
       (
         $valueWeight * ((earningsYieldNeutralScore + bookYieldNeutralScore) / 2)
         + $momentumWeight * momentumNeutralScore
         + $dividendWeight * dividendNeutralScore
       ) / NULLIF($valueWeight + $momentumWeight + $dividendWeight, 0)
         AS compositeScore
FROM industry_ranks;

CREATE OR REPLACE TEMP TABLE multifactor_results AS
WITH ranked AS (
  SELECT *,
         NTILE(CAST($layers AS INTEGER)) OVER (
           PARTITION BY signalMonth
           ORDER BY compositeScore
         ) AS factorLayer,
         ROW_NUMBER() OVER (
           PARTITION BY signalMonth
           ORDER BY compositeScore DESC, instrumentKey
         ) AS selectionRank,
         COUNT(*) OVER (PARTITION BY signalMonth) AS eligibleCount
  FROM multifactor_neutralized
)
SELECT *,
       selectionRank <= CAST($poolSize AS INTEGER) AS selected
FROM ranked;

CREATE OR REPLACE TEMP TABLE multifactor_portfolio_monthly AS
WITH month_pairs AS (
  SELECT signalMonth,
         LAG(signalMonth) OVER (ORDER BY signalMonth) AS previousSignalMonth
  FROM multifactor_calendar
),
monthly_returns AS (
  SELECT signalMonth,
         ROUND(
           AVG(adjustedMonthlyReturn) FILTER (WHERE selected),
           12
         ) AS selectedPortfolioReturn,
         ROUND(AVG(adjustedMonthlyReturn), 12) AS eligibleUniverseReturn,
         COUNT(*) FILTER (WHERE selected) AS selectedCount,
         COUNT(DISTINCT level1Code) FILTER (WHERE selected) AS selectedIndustryCount
  FROM multifactor_results
  GROUP BY signalMonth
),
overlap AS (
  SELECT pair.signalMonth,
         COUNT(previous.instrumentKey) AS retainedFromPreviousMonth
  FROM month_pairs AS pair
  LEFT JOIN multifactor_results AS current
    ON current.signalMonth = pair.signalMonth
   AND current.selected
  LEFT JOIN multifactor_results AS previous
    ON previous.signalMonth = pair.previousSignalMonth
   AND previous.instrumentKey = current.instrumentKey
   AND previous.selected
  GROUP BY pair.signalMonth
),
monthly AS (
  SELECT returns.*,
         overlap.retainedFromPreviousMonth,
         CASE
           WHEN pair.previousSignalMonth IS NULL THEN NULL
           ELSE 1 - overlap.retainedFromPreviousMonth * 1.0 / NULLIF(returns.selectedCount, 0)
         END AS oneWayTurnover,
         returns.selectedPortfolioReturn - returns.eligibleUniverseReturn AS excessReturn
  FROM monthly_returns AS returns
  INNER JOIN month_pairs AS pair USING (signalMonth)
  INNER JOIN overlap USING (signalMonth)
)
SELECT *,
       EXP(
         SUM(LN(1 + selectedPortfolioReturn)) OVER (ORDER BY signalMonth)
       ) - 1 AS selectedCumulativeReturn,
       EXP(
         SUM(LN(1 + eligibleUniverseReturn)) OVER (ORDER BY signalMonth)
       ) - 1 AS universeCumulativeReturn
FROM monthly
ORDER BY signalMonth;

SELECT COUNT(*) AS resultRows,
       COUNT(DISTINCT signalMonth) AS signalMonths,
       COUNT(DISTINCT symbol) AS symbols,
       MIN(signalDate) AS firstSignalDate,
       MAX(signalDate) AS lastSignalDate
FROM multifactor_results;

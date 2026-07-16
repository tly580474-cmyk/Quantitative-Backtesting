CREATE OR REPLACE TEMP TABLE factor_universe AS
WITH calculated AS (
  SELECT instrumentKey,
         market,
         symbol,
         name,
         tradeDate,
         close,
         amount,
         close / NULLIF(LAG(close, 20) OVER instrument_window, 0) - 1 AS momentum20,
         LEAD(open, 1) OVER instrument_window AS entryOpen,
         LEAD(close, 5) OVER instrument_window AS exitClose
  FROM bars
  WHERE tradeDate BETWEEN CAST($startDate AS DATE) - INTERVAL 45 DAY AND $endDate
  WINDOW instrument_window AS (
    PARTITION BY instrumentKey ORDER BY tradeDate
  )
),
ranked AS (
  SELECT *,
         PERCENT_RANK() OVER (
           PARTITION BY tradeDate ORDER BY momentum20
         ) AS momentumPercentile
  FROM calculated
  WHERE tradeDate BETWEEN $startDate AND $endDate
    AND amount >= $minAmount
    AND momentum20 IS NOT NULL
    AND entryOpen > 0
    AND exitClose > 0
)
SELECT *,
       NTILE(5) OVER (
         PARTITION BY tradeDate ORDER BY momentum20
       ) AS factorLayer,
       exitClose / entryOpen - 1 AS futureReturn
FROM ranked;

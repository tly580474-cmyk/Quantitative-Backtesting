-- 复现 csi1000LowPbSelection 在 2026-08-31 再平衡日的 top-200
WITH
constituent_snapshots AS (
  SELECT * FROM index_constituent_snapshots
  WHERE indexCode = '000852'
),
rebalance_snapshots AS (
  SELECT
    s.snapshotId,
    s.constituentDate,
    row_number() OVER (
      ORDER BY s.constituentDate DESC, (s.weightDate IS NOT NULL) DESC, s.fetchedAt DESC
    ) AS rn
  FROM constituent_snapshots s
  WHERE s.constituentDate <= DATE '2026-08-31'
  QUALIFY rn = 1
),
constituents AS (
  SELECT * FROM index_constituents
),
lifecycle AS (
  SELECT
    instrumentKey,
    min(tradeDate) AS firstDate
  FROM bars
  GROUP BY instrumentKey
),
eligible AS (
  SELECT
    b.instrumentKey,
    b.market,
    b.symbol,
    b.name,
    b.industry,
    b.pb,
    b.totalMarketCap,
    b.close AS selectedPrice,
    l.firstDate
  FROM rebalance_snapshots rs
  JOIN constituents c ON c.snapshotId = rs.snapshotId
  JOIN bars b
    ON b.tradeDate = DATE '2026-08-31'
   AND b.symbol = c.constituentCode
  JOIN lifecycle l ON l.instrumentKey = b.instrumentKey
  WHERE b.market IN ('SH', 'SZ')
    AND b.pb IS NOT NULL AND b.pb > 0
    AND b.totalMarketCap IS NOT NULL AND b.totalMarketCap > 0
    AND b.close IS NOT NULL AND b.close > 0
    AND coalesce(b.volume, 0) > 0
    AND upper(coalesce(b.name, '')) NOT LIKE '%ST%'
    AND coalesce(b.name, '') NOT LIKE '%退%'
    AND date_diff('day', l.firstDate, DATE '2026-08-31') >= 180
)
SELECT symbol, name, market, industry, pb, totalMarketCap, rank
FROM (
  SELECT symbol, name, market, industry, pb, totalMarketCap,
         ROW_NUMBER() OVER (ORDER BY pb, symbol) AS rank
  FROM eligible
)
WHERE rank <= 200
ORDER BY rank;

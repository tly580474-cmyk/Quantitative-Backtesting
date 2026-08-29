CREATE OR REPLACE TEMP TABLE market_structure_raw AS
WITH stock_prices AS (
  SELECT
    bar.instrumentKey, bar.market, bar.tradeDate, bar.amount,
    bar.close * COALESCE(factor.factor, 1) + COALESCE(factor.priceOffset, 0) AS adjusted_close
  FROM read_parquet('__BARS_PATH__', hive_partitioning = true) AS bar
  ASOF LEFT JOIN read_parquet('__ADJUSTMENT_PATH__') AS factor
    ON bar.instrumentKey = factor.instrumentKey
   AND bar.tradeDate >= factor.effectiveDate
  WHERE bar.market IN ('SH', 'SZ', 'BJ') AND bar.close > 0
), stock_base AS (
  SELECT
    *,
    ROW_NUMBER() OVER instrument_window AS history_count,
    LAG(adjusted_close, 1) OVER instrument_window AS close_1d,
    AVG(adjusted_close) OVER trailing_20 AS ma20,
    AVG(adjusted_close) OVER trailing_60 AS ma60,
    QUANTILE_CONT(amount, 0.20) OVER trailing_60_prior AS amount_q20_60d
  FROM stock_prices
  WINDOW
    instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate),
    trailing_20 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
    trailing_60 AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW),
    trailing_60_prior AS (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING)
), stock_returns AS (
  SELECT
    *,
    CASE WHEN close_1d > 0 THEN LEAST(0.30, GREATEST(-0.30, adjusted_close / close_1d - 1.0)) END
      AS stock_return,
    CASE WHEN close_1d > 0 AND amount > 0
      THEN ABS(adjusted_close / close_1d - 1.0) / (amount / 100000000.0) END AS amihud_1d
  FROM stock_base
), stock_windows AS (
  SELECT *, MEDIAN(amihud_1d) OVER (
    PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
  ) AS amihud_20d
  FROM stock_returns
), eligible AS (
  SELECT *, QUANTILE_CONT(amount, 0.95) OVER (PARTITION BY tradeDate) AS amount_q95_cross_section
  FROM stock_windows
  WHERE history_count >= 120 AND stock_return IS NOT NULL AND amount > 0
), stock_cross_section AS (
  SELECT
    tradeDate,
    COUNT(*) AS eligible_stocks,
    AVG(stock_return) AS equal_weight_return,
    100.0 * AVG(CASE WHEN adjusted_close > ma20 THEN 1.0 ELSE 0.0 END) AS pct_above_ma20,
    100.0 * AVG(CASE WHEN adjusted_close > ma60 THEN 1.0 ELSE 0.0 END) AS pct_above_ma60,
    AVG(CASE WHEN stock_return < 0 THEN 1.0 ELSE 0.0 END) AS loss_fraction,
    MEDIAN(amihud_20d) AS median_amihud_20d,
    AVG(CASE WHEN amount_q20_60d IS NOT NULL AND amount < amount_q20_60d THEN 1.0 ELSE 0.0 END)
      AS liquidity_drought_fraction,
    SUM(CASE WHEN amount >= amount_q95_cross_section THEN amount ELSE 0.0 END)
      / NULLIF(SUM(amount), 0) AS turnover_top5pct_share,
    EXP(SUM(LN(1.0 + AVG(stock_return))) OVER (ORDER BY tradeDate)) AS equal_weight_index
  FROM eligible
  GROUP BY tradeDate
), market_risk AS (
  SELECT
    *,
    SQRT(252.0 * AVG(POWER(LEAST(equal_weight_return, 0.0), 2)) OVER trailing_20)
      AS downside_semivol_20d,
    -(equal_weight_index / MAX(equal_weight_index) OVER trailing_60 - 1.0) AS drawdown_magnitude_60d,
    AVG(CASE WHEN equal_weight_return < 0 THEN loss_fraction END) OVER trailing_20
      AS downside_comovement_20d
  FROM stock_cross_section
  WINDOW
    trailing_20 AS (ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
    trailing_60 AS (ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
), index_window AS (
  SELECT
    indexCode, tradeDate, close,
    LAG(close, 20) OVER index_order AS close_20d,
    LAG(close, 60) OVER index_order AS close_60d,
    AVG(close) OVER trailing_20 AS ma20,
    AVG(close) OVER trailing_60 AS ma60
  FROM read_parquet('__INDEX_PATH__')
  WHERE indexCode IN ('000300', '399001', '000905', '000852', '000688')
  WINDOW
    index_order AS (PARTITION BY indexCode ORDER BY tradeDate),
    trailing_20 AS (PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
    trailing_60 AS (PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
), index_features AS (
  SELECT
    tradeDate,
    MEDIAN(CASE WHEN close_20d > 0 THEN close / close_20d - 1.0 END) AS index_return_20d,
    MEDIAN(CASE WHEN close_60d > 0 THEN close / close_60d - 1.0 END) AS index_return_60d,
    AVG(CASE WHEN close > ma20 AND ma20 > ma60 THEN 1.0 ELSE 0.0 END) AS index_trend_alignment,
    COUNT(*) AS available_indices
  FROM index_window
  GROUP BY tradeDate
), industry_window AS (
  SELECT
    indexCode, tradeDate, close,
    AVG(close) OVER (PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS ma60,
    COUNT(close) OVER (PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
      AS observations_60d
  FROM read_parquet('__INDUSTRY_PATH__')
), industry_features AS (
  SELECT
    tradeDate,
    100.0 * AVG(CASE WHEN close > ma60 THEN 1.0 ELSE 0.0 END) AS pct_industries_above_ma60,
    COUNT(*) AS available_industries
  FROM industry_window
  WHERE observations_60d = 60
  GROUP BY tradeDate
), raw AS (
  SELECT
    risk.tradeDate, risk.eligible_stocks,
    index_feature.available_indices,
    industry.available_industries,
    index_feature.index_return_20d,
    index_feature.index_return_60d,
    index_feature.index_trend_alignment,
    risk.pct_above_ma20,
    risk.pct_above_ma60,
    industry.pct_industries_above_ma60,
    risk.downside_semivol_20d,
    risk.drawdown_magnitude_60d,
    risk.downside_comovement_20d,
    risk.median_amihud_20d,
    risk.liquidity_drought_fraction,
    risk.turnover_top5pct_share
  FROM market_risk AS risk
  INNER JOIN index_features AS index_feature USING (tradeDate)
  LEFT JOIN industry_features AS industry USING (tradeDate)
  WHERE index_feature.available_indices >= 4
    AND industry.pct_industries_above_ma60 IS NOT NULL
)
SELECT * FROM raw
ORDER BY tradeDate DESC
LIMIT 900;

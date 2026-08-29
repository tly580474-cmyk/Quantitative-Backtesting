-- MHI v1 baseline experiment.
-- All rolling normalizers exclude the current observation. No future label participates in scoring.

CREATE OR REPLACE MACRO mhi_good_score(value, median_value, q25, q75) AS (
  CASE
    WHEN value IS NULL OR median_value IS NULL THEN NULL
    WHEN q75 IS NULL OR q25 IS NULL OR q75 - q25 < 1e-12 THEN 50.0
    ELSE LEAST(100.0, GREATEST(0.0, 50.0 + 25.0 * (value - median_value) / (q75 - q25)))
  END
);

CREATE OR REPLACE MACRO mhi_bad_score(value, median_value, q25, q75) AS (
  CASE
    WHEN mhi_good_score(value, median_value, q25, q75) IS NULL THEN NULL
    ELSE 100.0 - mhi_good_score(value, median_value, q25, q75)
  END
);

CREATE OR REPLACE TEMP TABLE mhi_stock_windows AS
WITH base AS (
  SELECT
    instrumentKey,
    market,
    symbol,
    name,
    tradeDate,
    adjustedClose,
    amount,
    ROW_NUMBER() OVER instrument_window AS history_count,
    LAG(adjustedClose, 1) OVER instrument_window AS close_1d,
    AVG(adjustedClose) OVER trailing_20 AS ma20,
    AVG(adjustedClose) OVER trailing_60 AS ma60,
    QUANTILE_CONT(amount, 0.20) OVER trailing_60_prior AS amount_q20_60d
  FROM stock_prices_qfq
  WHERE tradeDate >= CAST($sourceStartDate AS DATE)
    AND market IN ('SH', 'SZ', 'BJ')
    AND adjustedClose > 0
  WINDOW
    instrument_window AS (PARTITION BY instrumentKey ORDER BY tradeDate),
    trailing_20 AS (
      PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
    ),
    trailing_60 AS (
      PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ),
    trailing_60_prior AS (
      PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING
    )
), returns AS (
  SELECT
    *,
    CASE
      WHEN close_1d > 0 THEN LEAST(0.30, GREATEST(-0.30, adjustedClose / close_1d - 1.0))
      ELSE NULL
    END AS stock_return,
    CASE
      WHEN close_1d > 0 AND amount > 0
        THEN ABS(adjustedClose / close_1d - 1.0) / (amount / 100000000.0)
      ELSE NULL
    END AS amihud_1d
  FROM base
)
SELECT
  *,
  MEDIAN(amihud_1d) OVER (
    PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
  ) AS amihud_20d
FROM returns;

CREATE OR REPLACE TEMP TABLE mhi_stock_cross_section AS
WITH eligible AS (
  SELECT
    *,
    QUANTILE_CONT(amount, 0.95) OVER (PARTITION BY tradeDate) AS amount_q95_cross_section
  FROM mhi_stock_windows
  WHERE history_count >= 120
    AND stock_return IS NOT NULL
    AND amount > 0
), daily AS (
  SELECT
    tradeDate,
    COUNT(*) AS eligible_stocks,
    AVG(stock_return) AS equal_weight_return,
    100.0 * AVG(CASE WHEN adjustedClose > ma20 THEN 1.0 ELSE 0.0 END) AS pct_above_ma20,
    100.0 * AVG(CASE WHEN adjustedClose > ma60 THEN 1.0 ELSE 0.0 END) AS pct_above_ma60,
    AVG(CASE WHEN stock_return < 0 THEN 1.0 ELSE 0.0 END) AS loss_fraction,
    MEDIAN(amihud_20d) AS median_amihud_20d,
    AVG(CASE WHEN amount_q20_60d IS NOT NULL AND amount < amount_q20_60d THEN 1.0 ELSE 0.0 END)
      AS liquidity_drought_fraction,
    SUM(CASE WHEN amount >= amount_q95_cross_section THEN amount ELSE 0.0 END) / NULLIF(SUM(amount), 0)
      AS turnover_top5pct_share,
    100.0 * (
      SUM(CASE WHEN stock_return > 0 THEN 1 ELSE 0 END)
      - SUM(CASE WHEN stock_return < 0 THEN 1 ELSE 0 END)
    ) / NULLIF(SUM(CASE WHEN stock_return <> 0 THEN 1 ELSE 0 END), 0) AS msi_breadth_proxy,
    100.0 * SUM(
      SQRT(amount / 100000000.0)
      * LEAST(7.0, GREATEST(-7.0, stock_return * 100.0))
    ) / NULLIF(SUM(SQRT(amount / 100000000.0) * 7.0), 0) AS msi_strength_proxy
  FROM eligible
  GROUP BY tradeDate
)
SELECT
  *,
  EXP(SUM(LN(1.0 + equal_weight_return)) OVER (ORDER BY tradeDate)) AS equal_weight_index
FROM daily;

CREATE OR REPLACE TEMP TABLE mhi_market_risk AS
SELECT
  *,
  SQRT(252.0 * AVG(POWER(LEAST(equal_weight_return, 0.0), 2)) OVER trailing_20) AS downside_semivol_20d,
  equal_weight_index / MAX(equal_weight_index) OVER trailing_60 - 1.0 AS current_drawdown_60d,
  AVG(CASE WHEN equal_weight_return < 0 THEN loss_fraction END) OVER trailing_20
    AS downside_comovement_20d
FROM mhi_stock_cross_section
WINDOW
  trailing_20 AS (ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
  trailing_60 AS (ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW);

CREATE OR REPLACE TEMP TABLE mhi_index_features AS
WITH index_window AS (
  SELECT
    indexCode,
    tradeDate,
    close,
    LAG(close, 20) OVER index_window AS close_20d,
    LAG(close, 60) OVER index_window AS close_60d,
    AVG(close) OVER trailing_20 AS ma20,
    AVG(close) OVER trailing_60 AS ma60,
    changePercent
  FROM index_bars
  WHERE indexCode IN ('000300', '399001', '000905', '000852', '000688')
    AND tradeDate >= CAST($sourceStartDate AS DATE)
  WINDOW
    index_window AS (PARTITION BY indexCode ORDER BY tradeDate),
    trailing_20 AS (
      PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
    ),
    trailing_60 AS (
      PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    )
)
SELECT
  tradeDate,
  MEDIAN(CASE WHEN close_20d > 0 THEN close / close_20d - 1.0 END) AS index_return_20d,
  MEDIAN(CASE WHEN close_60d > 0 THEN close / close_60d - 1.0 END) AS index_return_60d,
  AVG(CASE WHEN close > ma20 AND ma20 > ma60 THEN 1.0 ELSE 0.0 END) AS index_trend_alignment,
  COUNT(*) AS available_indices,
  100.0 * TANH(SUM(
    changePercent * CASE indexCode
      WHEN '000300' THEN 0.50
      WHEN '399001' THEN 0.20
      WHEN '000905' THEN 0.15
      WHEN '000852' THEN 0.10
      WHEN '000688' THEN 0.05
      ELSE 0.0
    END
  ) / NULLIF(SUM(CASE indexCode
      WHEN '000300' THEN 0.50
      WHEN '399001' THEN 0.20
      WHEN '000905' THEN 0.15
      WHEN '000852' THEN 0.10
      WHEN '000688' THEN 0.05
      ELSE 0.0
    END), 0) / 1.5) AS msi_index_proxy
FROM index_window
GROUP BY tradeDate;

CREATE OR REPLACE TEMP TABLE mhi_industry_features AS
WITH industry_window AS (
  SELECT
    indexCode,
    tradeDate,
    close,
    AVG(close) OVER (
      PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) AS ma60,
    COUNT(close) OVER (
      PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) AS observations_60d
  FROM sw_industry_bars
  WHERE tradeDate >= CAST($sourceStartDate AS DATE)
)
SELECT
  tradeDate,
  100.0 * AVG(CASE WHEN close > ma60 THEN 1.0 ELSE 0.0 END) AS pct_industries_above_ma60,
  COUNT(*) AS available_industries
FROM industry_window
WHERE observations_60d = 60
GROUP BY tradeDate;

CREATE OR REPLACE TEMP TABLE mhi_raw_features AS
SELECT
  risk.tradeDate,
  risk.eligible_stocks,
  risk.equal_weight_return,
  risk.equal_weight_index,
  index_feature.index_return_20d,
  index_feature.index_return_60d,
  index_feature.index_trend_alignment,
  risk.pct_above_ma20,
  risk.pct_above_ma60,
  industry.pct_industries_above_ma60,
  risk.downside_semivol_20d,
  -risk.current_drawdown_60d AS drawdown_magnitude_60d,
  risk.downside_comovement_20d,
  risk.median_amihud_20d,
  risk.liquidity_drought_fraction,
  risk.turnover_top5pct_share,
  risk.msi_breadth_proxy,
  risk.msi_strength_proxy,
  index_feature.msi_index_proxy,
  0.25 / 0.85 * risk.msi_breadth_proxy
    + 0.20 / 0.85 * risk.msi_strength_proxy
    + 0.40 / 0.85 * index_feature.msi_index_proxy AS msi_proxy
FROM mhi_market_risk AS risk
INNER JOIN mhi_index_features AS index_feature USING (tradeDate)
LEFT JOIN mhi_industry_features AS industry USING (tradeDate)
WHERE index_feature.available_indices >= 4;

CREATE OR REPLACE TEMP TABLE mhi_history_stats AS
SELECT
  *,
  COUNT(index_return_20d) OVER history_window AS history_observations,
  MEDIAN(index_return_20d) OVER history_window AS index_return_20d_med,
  QUANTILE_CONT(index_return_20d, 0.25) OVER history_window AS index_return_20d_q25,
  QUANTILE_CONT(index_return_20d, 0.75) OVER history_window AS index_return_20d_q75,
  MEDIAN(index_return_60d) OVER history_window AS index_return_60d_med,
  QUANTILE_CONT(index_return_60d, 0.25) OVER history_window AS index_return_60d_q25,
  QUANTILE_CONT(index_return_60d, 0.75) OVER history_window AS index_return_60d_q75,
  MEDIAN(downside_semivol_20d) OVER history_window AS semivol_med,
  QUANTILE_CONT(downside_semivol_20d, 0.25) OVER history_window AS semivol_q25,
  QUANTILE_CONT(downside_semivol_20d, 0.75) OVER history_window AS semivol_q75,
  MEDIAN(drawdown_magnitude_60d) OVER history_window AS drawdown_med,
  QUANTILE_CONT(drawdown_magnitude_60d, 0.25) OVER history_window AS drawdown_q25,
  QUANTILE_CONT(drawdown_magnitude_60d, 0.75) OVER history_window AS drawdown_q75,
  MEDIAN(downside_comovement_20d) OVER history_window AS comovement_med,
  QUANTILE_CONT(downside_comovement_20d, 0.25) OVER history_window AS comovement_q25,
  QUANTILE_CONT(downside_comovement_20d, 0.75) OVER history_window AS comovement_q75,
  MEDIAN(median_amihud_20d) OVER history_window AS amihud_med,
  QUANTILE_CONT(median_amihud_20d, 0.25) OVER history_window AS amihud_q25,
  QUANTILE_CONT(median_amihud_20d, 0.75) OVER history_window AS amihud_q75,
  MEDIAN(liquidity_drought_fraction) OVER history_window AS drought_med,
  QUANTILE_CONT(liquidity_drought_fraction, 0.25) OVER history_window AS drought_q25,
  QUANTILE_CONT(liquidity_drought_fraction, 0.75) OVER history_window AS drought_q75,
  MEDIAN(turnover_top5pct_share) OVER history_window AS concentration_med,
  QUANTILE_CONT(turnover_top5pct_share, 0.25) OVER history_window AS concentration_q25,
  QUANTILE_CONT(turnover_top5pct_share, 0.75) OVER history_window AS concentration_q75
FROM mhi_raw_features
WINDOW history_window AS (ORDER BY tradeDate ROWS BETWEEN 756 PRECEDING AND 1 PRECEDING);

CREATE OR REPLACE TEMP TABLE mhi_components AS
WITH sub_scores AS (
  SELECT
    *,
    mhi_good_score(
      index_return_20d, index_return_20d_med, index_return_20d_q25, index_return_20d_q75
    ) AS trend_20d_score,
    mhi_good_score(
      index_return_60d, index_return_60d_med, index_return_60d_q25, index_return_60d_q75
    ) AS trend_60d_score,
    100.0 * index_trend_alignment AS trend_alignment_score,
    LEAST(100.0, GREATEST(0.0, pct_above_ma20)) AS breadth_20d_score,
    LEAST(100.0, GREATEST(0.0, pct_above_ma60)) AS breadth_60d_score,
    LEAST(100.0, GREATEST(0.0, pct_industries_above_ma60)) AS industry_breadth_score,
    mhi_bad_score(downside_semivol_20d, semivol_med, semivol_q25, semivol_q75)
      AS semivol_score,
    mhi_bad_score(drawdown_magnitude_60d, drawdown_med, drawdown_q25, drawdown_q75)
      AS drawdown_score,
    mhi_bad_score(downside_comovement_20d, comovement_med, comovement_q25, comovement_q75)
      AS comovement_score,
    mhi_bad_score(median_amihud_20d, amihud_med, amihud_q25, amihud_q75)
      AS amihud_score,
    mhi_bad_score(liquidity_drought_fraction, drought_med, drought_q25, drought_q75)
      AS drought_score,
    mhi_bad_score(turnover_top5pct_share, concentration_med, concentration_q25, concentration_q75)
      AS concentration_score
  FROM mhi_history_stats
  WHERE history_observations >= 252
), components AS (
  SELECT
    *,
    (trend_20d_score + trend_60d_score + trend_alignment_score) / 3.0 AS trend_score,
    0.40 * breadth_20d_score + 0.40 * breadth_60d_score + 0.20 * industry_breadth_score
      AS participation_score,
    0.40 * semivol_score + (1.0 / 3.0) * drawdown_score + (4.0 / 15.0) * comovement_score
      AS risk_score,
    (8.0 / 15.0) * amihud_score + (4.0 / 15.0) * drought_score
      + (3.0 / 15.0) * concentration_score AS liquidity_score
  FROM sub_scores
)
SELECT
  *,
  0.30 * trend_score + 0.25 * participation_score + 0.30 * risk_score + 0.15 * liquidity_score
    AS mhi,
  (0.25 * participation_score + 0.30 * risk_score + 0.15 * liquidity_score) / 0.70
    AS mhi_without_trend,
  (0.30 * trend_score + 0.30 * risk_score + 0.15 * liquidity_score) / 0.75
    AS mhi_without_participation,
  (0.30 * trend_score + 0.25 * participation_score + 0.15 * liquidity_score) / 0.70
    AS mhi_without_risk,
  (0.30 * trend_score + 0.25 * participation_score + 0.30 * risk_score) / 0.85
    AS mhi_without_liquidity
FROM components
WHERE pct_industries_above_ma60 IS NOT NULL;

CREATE OR REPLACE TEMP TABLE mhi_labeled AS
SELECT
  *,
  LEAD(equal_weight_index, 20) OVER calendar_window / equal_weight_index - 1.0 AS forward_return_20d,
  LEAD(equal_weight_index, 60) OVER calendar_window / equal_weight_index - 1.0 AS forward_return_60d,
  MIN(equal_weight_index) OVER (
    ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING
  ) / equal_weight_index - 1.0 AS forward_worst_return_20d,
  SQRT(252.0 * AVG(POWER(LEAST(equal_weight_return, 0.0), 2)) OVER (
    ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING
  )) AS forward_downside_semivol_20d
FROM mhi_components
WINDOW calendar_window AS (ORDER BY tradeDate)
QUALIFY tradeDate BETWEEN CAST($evaluationStartDate AS DATE) AND CAST($evaluationEndDate AS DATE);

CREATE OR REPLACE TEMP TABLE mhi_validated AS
SELECT
  *,
  CASE WHEN forward_worst_return_20d <= -0.08 THEN 1 ELSE 0 END AS severe_drawdown_20d,
  NTILE(10) OVER (ORDER BY mhi) AS mhi_decile
FROM mhi_labeled
WHERE forward_return_20d IS NOT NULL
  AND forward_return_60d IS NOT NULL
  AND forward_worst_return_20d IS NOT NULL
  AND forward_downside_semivol_20d IS NOT NULL;

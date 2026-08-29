-- MHI v3 macro increment.  Each series is scored only against information
-- available before the current observation and is kept as an independent axis.

CREATE OR REPLACE TEMP TABLE mhi_v3_pmi_raw AS
SELECT
  CAST(observation_month AS DATE) AS observation_month,
  CAST(availability_date AS DATE) AS availability_date,
  CAST(manufacturing_pmi AS DOUBLE) AS manufacturing_pmi,
  CAST(non_manufacturing_pmi AS DOUBLE) AS non_manufacturing_pmi
FROM read_csv_auto('experiments/mhi-v3/data/raw/pmi.csv', header = true);

CREATE OR REPLACE TEMP TABLE mhi_v3_ppi_raw AS
SELECT
  CAST(observation_month AS DATE) AS observation_month,
  CAST(availability_date AS DATE) AS availability_date,
  CAST(ppi_yoy AS DOUBLE) AS ppi_yoy
FROM read_csv_auto('experiments/mhi-v3/data/raw/ppi.csv', header = true);

CREATE OR REPLACE TEMP TABLE mhi_v3_money_raw AS
SELECT
  CAST(observation_month AS DATE) AS observation_month,
  CAST(availability_date AS DATE) AS availability_date,
  CAST(m2_yoy AS DOUBLE) AS m2_yoy,
  CAST(m1_yoy AS DOUBLE) AS m1_yoy,
  CAST(m1_m2_gap AS DOUBLE) AS m1_m2_gap
FROM read_csv_auto('experiments/mhi-v3/data/raw/money-supply.csv', header = true);

CREATE OR REPLACE TEMP TABLE mhi_v3_pmi_scored AS
WITH changes AS (
  SELECT *, manufacturing_pmi - LAG(manufacturing_pmi, 3) OVER (ORDER BY observation_month) AS pmi_change_3m
  FROM mhi_v3_pmi_raw
), history AS (
  SELECT *,
    COUNT(manufacturing_pmi) OVER hist AS history_months,
    MEDIAN(manufacturing_pmi) OVER hist AS level_med,
    QUANTILE_CONT(manufacturing_pmi, 0.25) OVER hist AS level_q25,
    QUANTILE_CONT(manufacturing_pmi, 0.75) OVER hist AS level_q75,
    MEDIAN(pmi_change_3m) OVER hist AS change_med,
    QUANTILE_CONT(pmi_change_3m, 0.25) OVER hist AS change_q25,
    QUANTILE_CONT(pmi_change_3m, 0.75) OVER hist AS change_q75
  FROM changes
  WINDOW hist AS (ORDER BY observation_month ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING)
)
SELECT *,
  0.60 * mhi_good_score(manufacturing_pmi, level_med, level_q25, level_q75)
    + 0.40 * mhi_good_score(pmi_change_3m, change_med, change_q25, change_q75)
    AS growth_cycle_score
FROM history
WHERE history_months >= 36 AND pmi_change_3m IS NOT NULL;

CREATE OR REPLACE TEMP TABLE mhi_v3_ppi_scored AS
WITH changes AS (
  SELECT *, ppi_yoy - LAG(ppi_yoy, 3) OVER (ORDER BY observation_month) AS ppi_change_3m
  FROM mhi_v3_ppi_raw
), history AS (
  SELECT *,
    COUNT(ppi_yoy) OVER hist AS history_months,
    MEDIAN(ppi_yoy) OVER hist AS level_med,
    QUANTILE_CONT(ppi_yoy, 0.25) OVER hist AS level_q25,
    QUANTILE_CONT(ppi_yoy, 0.75) OVER hist AS level_q75,
    MEDIAN(ppi_change_3m) OVER hist AS change_med,
    QUANTILE_CONT(ppi_change_3m, 0.25) OVER hist AS change_q25,
    QUANTILE_CONT(ppi_change_3m, 0.75) OVER hist AS change_q75
  FROM changes
  WINDOW hist AS (ORDER BY observation_month ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING)
)
SELECT *,
  0.60 * mhi_good_score(ppi_yoy, level_med, level_q25, level_q75)
    + 0.40 * mhi_good_score(ppi_change_3m, change_med, change_q25, change_q75)
    AS nominal_cycle_score
FROM history
WHERE history_months >= 36 AND ppi_change_3m IS NOT NULL;

CREATE OR REPLACE TEMP TABLE mhi_v3_money_scored AS
WITH changes AS (
  SELECT *, m1_m2_gap - LAG(m1_m2_gap, 3) OVER (ORDER BY observation_month) AS gap_change_3m
  FROM mhi_v3_money_raw
), history AS (
  SELECT *,
    COUNT(m1_m2_gap) OVER hist AS history_months,
    MEDIAN(m1_m2_gap) OVER hist AS gap_med,
    QUANTILE_CONT(m1_m2_gap, 0.25) OVER hist AS gap_q25,
    QUANTILE_CONT(m1_m2_gap, 0.75) OVER hist AS gap_q75,
    MEDIAN(gap_change_3m) OVER hist AS change_med,
    QUANTILE_CONT(gap_change_3m, 0.25) OVER hist AS change_q25,
    QUANTILE_CONT(gap_change_3m, 0.75) OVER hist AS change_q75
  FROM changes
  WINDOW hist AS (ORDER BY observation_month ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING)
)
SELECT *,
  0.60 * mhi_good_score(m1_m2_gap, gap_med, gap_q25, gap_q75)
    + 0.40 * mhi_good_score(gap_change_3m, change_med, change_q25, change_q75)
    AS money_activity_score
FROM history
WHERE history_months >= 36
  AND gap_change_3m IS NOT NULL
  -- PBOC changed the M1 definition from the January 2025 observation.  The
  -- mirror retains the old-definition 2024 history, so values across this
  -- boundary are not comparable and are excluded rather than spliced.
  AND observation_month < DATE '2025-01-01';

CREATE OR REPLACE TEMP TABLE mhi_v3_daily_macro AS
SELECT
  base.*,
  pmi.observation_month AS pmi_observation_month,
  pmi.availability_date AS pmi_availability_date,
  pmi.manufacturing_pmi,
  pmi.pmi_change_3m,
  pmi.growth_cycle_score,
  ppi.observation_month AS ppi_observation_month,
  ppi.availability_date AS ppi_availability_date,
  ppi.ppi_yoy,
  ppi.ppi_change_3m,
  ppi.nominal_cycle_score,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.observation_month END AS money_observation_month,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.availability_date END AS money_availability_date,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.m1_yoy END AS m1_yoy,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.m2_yoy END AS m2_yoy,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.m1_m2_gap END AS m1_m2_gap,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.gap_change_3m END AS gap_change_3m,
  CASE WHEN base.tradeDate < DATE '2025-02-20' THEN money.money_activity_score END AS money_activity_score
FROM mhi_v2_labeled AS base
ASOF LEFT JOIN mhi_v3_pmi_scored AS pmi
  ON base.tradeDate >= pmi.availability_date
ASOF LEFT JOIN mhi_v3_ppi_scored AS ppi
  ON base.tradeDate >= ppi.availability_date
ASOF LEFT JOIN mhi_v3_money_scored AS money
  ON base.tradeDate >= money.availability_date;

CREATE OR REPLACE TEMP TABLE mhi_v3_validated AS
SELECT *,
  CASE WHEN forward_worst_return_20d <= -0.08 THEN 1 ELSE 0 END AS severe_drawdown_20d
FROM mhi_v3_daily_macro
WHERE tradeDate BETWEEN CAST($evaluationStartDate AS DATE) AND CAST($evaluationEndDate AS DATE)
  AND growth_cycle_score IS NOT NULL
  AND nominal_cycle_score IS NOT NULL
  AND forward_return_20d IS NOT NULL
  AND forward_return_60d IS NOT NULL
  AND forward_worst_return_20d IS NOT NULL
  AND forward_downside_semivol_20d IS NOT NULL;

CREATE OR REPLACE TEMP TABLE mhi_v3_monthly_sample AS
SELECT *
FROM mhi_v3_validated
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY DATE_TRUNC('month', tradeDate) ORDER BY tradeDate DESC
) = 1;

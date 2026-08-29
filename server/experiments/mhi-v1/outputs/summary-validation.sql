WITH deciles AS (
  SELECT
    mhi_decile,
    AVG(forward_worst_return_20d) AS worst_return,
    AVG(severe_drawdown_20d) AS severe_rate,
    AVG(forward_downside_semivol_20d) AS downside_vol,
    AVG(forward_return_20d) AS return_20d,
    AVG(forward_return_60d) AS return_60d
  FROM mhi_validated
  GROUP BY mhi_decile
), decile_ranks AS (
  SELECT
    *,
    RANK() OVER (ORDER BY worst_return) AS worst_return_rank,
    RANK() OVER (ORDER BY severe_rate) AS severe_rate_rank,
    RANK() OVER (ORDER BY downside_vol) AS downside_vol_rank
  FROM deciles
), edges AS (
  SELECT
    MAX(CASE WHEN mhi_decile = 1 THEN severe_rate END) AS bottom_severe_rate,
    MAX(CASE WHEN mhi_decile = 10 THEN severe_rate END) AS top_severe_rate,
    MAX(CASE WHEN mhi_decile = 1 THEN downside_vol END) AS bottom_downside_vol,
    MAX(CASE WHEN mhi_decile = 10 THEN downside_vol END) AS top_downside_vol,
    MAX(CASE WHEN mhi_decile = 1 THEN worst_return END) AS bottom_worst_return,
    MAX(CASE WHEN mhi_decile = 10 THEN worst_return END) AS top_worst_return
  FROM decile_ranks
)
SELECT 'mhi_msi_proxy_correlation' AS metric, ROUND(CORR(mhi, msi_proxy), 6) AS value
FROM mhi_validated
UNION ALL
SELECT 'mhi_forward_worst_return_20d_correlation', ROUND(CORR(mhi, forward_worst_return_20d), 6)
FROM mhi_validated
UNION ALL
SELECT 'mhi_forward_downside_semivol_20d_correlation', ROUND(CORR(mhi, forward_downside_semivol_20d), 6)
FROM mhi_validated
UNION ALL
SELECT 'mhi_forward_return_20d_correlation', ROUND(CORR(mhi, forward_return_20d), 6)
FROM mhi_validated
UNION ALL
SELECT 'mhi_forward_return_60d_correlation', ROUND(CORR(mhi, forward_return_60d), 6)
FROM mhi_validated
UNION ALL
SELECT 'decile_vs_worst_return_spearman', ROUND(CORR(mhi_decile, worst_return_rank), 6)
FROM decile_ranks
UNION ALL
SELECT 'decile_vs_severe_rate_spearman', ROUND(CORR(mhi_decile, severe_rate_rank), 6)
FROM decile_ranks
UNION ALL
SELECT 'decile_vs_downside_vol_spearman', ROUND(CORR(mhi_decile, downside_vol_rank), 6)
FROM decile_ranks
UNION ALL
SELECT 'bottom_minus_top_severe_drawdown_rate_pct', ROUND((bottom_severe_rate - top_severe_rate) * 100.0, 6)
FROM edges
UNION ALL
SELECT 'bottom_minus_top_downside_semivol_pct', ROUND((bottom_downside_vol - top_downside_vol) * 100.0, 6)
FROM edges
UNION ALL
SELECT 'top_minus_bottom_forward_worst_return_pct', ROUND((top_worst_return - bottom_worst_return) * 100.0, 6)
FROM edges;

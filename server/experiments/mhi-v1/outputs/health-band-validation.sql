WITH banded AS (
  SELECT
    *,
    CASE
      WHEN mhi < 20 THEN '00-20 critical'
      WHEN mhi < 40 THEN '20-40 fragile'
      WHEN mhi < 60 THEN '40-60 neutral'
      WHEN mhi < 80 THEN '60-80 healthy'
      ELSE '80-100 robust'
    END AS health_band
  FROM mhi_validated
)
SELECT
  health_band,
  COUNT(*) AS observations,
  ROUND(AVG(severe_drawdown_20d) * 100.0, 4) AS severe_drawdown_rate_pct,
  ROUND(AVG(forward_worst_return_20d) * 100.0, 4) AS average_forward_worst_return_20d_pct,
  ROUND(AVG(forward_downside_semivol_20d) * 100.0, 4) AS average_forward_downside_semivol_20d_pct,
  ROUND(AVG(forward_return_20d) * 100.0, 4) AS average_forward_return_20d_pct,
  ROUND(AVG(forward_return_60d) * 100.0, 4) AS average_forward_return_60d_pct
FROM banded
GROUP BY health_band
ORDER BY health_band;

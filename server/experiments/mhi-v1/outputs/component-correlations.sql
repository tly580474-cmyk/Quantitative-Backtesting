SELECT 'trend' AS component,
       ROUND(CORR(trend_score, forward_worst_return_20d), 6) AS corr_forward_worst_return,
       ROUND(CORR(trend_score, forward_downside_semivol_20d), 6) AS corr_forward_downside_vol,
       ROUND(CORR(trend_score, forward_return_60d), 6) AS corr_forward_return_60d,
       ROUND(CORR(trend_score, msi_proxy), 6) AS corr_msi_proxy
FROM mhi_validated
UNION ALL
SELECT 'participation', ROUND(CORR(participation_score, forward_worst_return_20d), 6),
       ROUND(CORR(participation_score, forward_downside_semivol_20d), 6),
       ROUND(CORR(participation_score, forward_return_60d), 6), ROUND(CORR(participation_score, msi_proxy), 6)
FROM mhi_validated
UNION ALL
SELECT 'risk', ROUND(CORR(risk_score, forward_worst_return_20d), 6),
       ROUND(CORR(risk_score, forward_downside_semivol_20d), 6),
       ROUND(CORR(risk_score, forward_return_60d), 6), ROUND(CORR(risk_score, msi_proxy), 6)
FROM mhi_validated
UNION ALL
SELECT 'liquidity', ROUND(CORR(liquidity_score, forward_worst_return_20d), 6),
       ROUND(CORR(liquidity_score, forward_downside_semivol_20d), 6),
       ROUND(CORR(liquidity_score, forward_return_60d), 6), ROUND(CORR(liquidity_score, msi_proxy), 6)
FROM mhi_validated;

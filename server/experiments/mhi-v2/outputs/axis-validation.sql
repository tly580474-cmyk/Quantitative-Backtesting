WITH axes AS (
  SELECT tradeDate, 'market_structure_health' AS axis, mhi AS score,
         forward_worst_return_20d, forward_downside_semivol_20d, forward_return_60d,
         forward_return_252d, forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, 'fundamental_health', fundamental_health,
         forward_worst_return_20d, forward_downside_semivol_20d, forward_return_60d,
         forward_return_252d, forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, 'valuation_support', valuation_support,
         forward_worst_return_20d, forward_downside_semivol_20d, forward_return_60d,
         forward_return_252d, forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, 'technical_fundamental_equal', technical_fundamental_equal,
         forward_worst_return_20d, forward_downside_semivol_20d, forward_return_60d,
         forward_return_252d, forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v2_validated
  UNION ALL
  SELECT tradeDate, 'three_axis_equal', three_axis_equal,
         forward_worst_return_20d, forward_downside_semivol_20d, forward_return_60d,
         forward_return_252d, forward_roe_change_252d, severe_drawdown_20d
  FROM mhi_v2_validated
)
SELECT
  axis,
  COUNT(*) AS short_horizon_observations,
  COUNT(forward_return_252d) AS long_horizon_observations,
  ROUND(CORR(score, forward_worst_return_20d), 6) AS corr_forward_worst_return_20d,
  ROUND(CORR(score, forward_downside_semivol_20d), 6) AS corr_forward_downside_semivol_20d,
  ROUND(CORR(score, forward_return_60d), 6) AS corr_forward_return_60d,
  ROUND(CORR(score, forward_return_252d), 6) AS corr_forward_return_252d,
  ROUND(CORR(score, forward_roe_change_252d), 6) AS corr_forward_roe_change_252d
FROM axes
GROUP BY axis
ORDER BY axis;

SELECT signalMonth,
       previousSignalMonth,
       action,
       indexCode,
       industryName,
       previousRank,
       currentRank,
       previousEqualWeight,
       currentEqualWeight,
       previousMarketCapWeight,
       currentMarketCapWeight
FROM sw_industry_rotation_changes
WHERE action <> 'HOLD'
ORDER BY signalMonth, action, currentRank, previousRank, indexCode;

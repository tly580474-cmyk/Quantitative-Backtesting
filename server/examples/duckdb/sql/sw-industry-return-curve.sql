SELECT signalMonth,
       signalDate,
       entryDate,
       exitDate,
       indexCode,
       industryCode,
       industryName,
       monthlyIndustryReturn,
       EXP(
         SUM(LN(1 + monthlyIndustryReturn)) OVER (
           PARTITION BY indexCode ORDER BY signalMonth
         )
       ) - 1 AS cumulativeIndustryReturn
FROM sw_industry_market_features
ORDER BY indexCode, signalMonth;

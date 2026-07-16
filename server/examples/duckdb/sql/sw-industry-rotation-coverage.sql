SELECT score.signalMonth,
       MAX(score.signalDate) AS signalDate,
       COUNT(*) AS industryCount,
       SUM(score.stockCount) AS stockMembershipRows,
       SUM(score.validPeCount) AS validPeStocks,
       SUM(score.validPbCount) AS validPbStocks,
       SUM(score.dividendStockCount) AS dividendStocks,
       MIN(score.stockCount) AS smallestIndustryStockCount,
       MAX(score.stockCount) AS largestIndustryStockCount
FROM sw_industry_rotation_scores AS score
GROUP BY score.signalMonth
ORDER BY score.signalMonth;

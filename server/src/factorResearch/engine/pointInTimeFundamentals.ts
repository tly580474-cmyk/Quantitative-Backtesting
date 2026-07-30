import type { FactorDependency } from '../definitions/schema.js';

export const FUNDAMENTAL_DEPENDENCIES = new Set<FactorDependency>([
  'roe',
  'grossMargin',
  'operatingCashFlowToRevenue',
  'freeCashFlowToEnterpriseValue',
  'debtToAssets',
  'receivablesTurnover',
  'inventoryTurnover',
  'revenueGrowth',
  'netProfitGrowth',
  'assetTurnover',
]);

/**
 * Produces an auditable point-in-time feature relation.
 *
 * Every row is selected using information that was public on signalDate.  A
 * later correction of the same report period is therefore invisible until its
 * own announcement date.
 */
export function buildPointInTimeFundamentalCte(
  financialParquetPath: string,
  barsRelation = 'bars',
): string {
  const path = financialParquetPath.replaceAll("'", "''").replaceAll('\\', '/');
  return `, financial_versions AS (
    SELECT *
    FROM read_parquet('${path}')
  ), financial_asof_ranked AS (
    SELECT b.tradeDate, b.instrumentKey,
           f.reportPeriod AS financialReportPeriod,
           f.announcementDate AS financialAnnouncementDate,
           f.sourceVersion AS financialSourceVersion,
           COALESCE(f.roeCalculatedPct, f.roeWeightedPct, f.roePct) AS roe,
           f.grossMarginPct AS grossMargin,
           f.operatingCashFlowToRevenuePct AS operatingCashFlowToRevenue,
           f.freeCashFlow / NULLIF(
             b.totalMarketCap + COALESCE(f.shortTermBorrowings, 0)
             + COALESCE(f.longTermBorrowings, 0) + COALESCE(f.bondsPayable, 0)
             - COALESCE(f.cashAndEquivalents, 0), 0
           ) AS freeCashFlowToEnterpriseValue,
           f.debtToAssetsPct AS debtToAssets,
           f.receivablesTurnover,
           f.inventoryTurnover,
           f.revenueYoyPct AS revenueGrowth,
           f.netProfitYoyPct AS netProfitGrowth,
           f.assetTurnover,
           ROW_NUMBER() OVER (
             PARTITION BY b.tradeDate, b.instrumentKey
             ORDER BY f.announcementDate DESC, f.reportPeriod DESC,
                      COALESCE(f.updateFlag, 0) DESC, f.fetchedAt DESC
           ) AS asofRank
    FROM ${barsRelation} b
    LEFT JOIN financial_versions f
      ON f.instrumentKey = b.instrumentKey
     AND f.announcementDate <= b.tradeDate
  ), financial_asof AS (
    SELECT * EXCLUDE (asofRank)
    FROM financial_asof_ranked
    WHERE asofRank = 1
  )`;
}

export function requiresPointInTimeFundamentals(dependencies: FactorDependency[]): boolean {
  return dependencies.some((dependency) => FUNDAMENTAL_DEPENDENCIES.has(dependency));
}

export interface CrossSectionPreprocessConfig {
  winsorLower: number;
  winsorUpper: number;
  industryNeutral: boolean;
  marketCapNeutral: boolean;
  minimumCoverage: number;
}

export const DEFAULT_CROSS_SECTION_PREPROCESS: CrossSectionPreprocessConfig = {
  winsorLower: 0.01,
  winsorUpper: 0.99,
  industryNeutral: true,
  marketCapNeutral: true,
  minimumCoverage: 0.70,
};

/** SQL expression for 1/99 winsorisation followed by z-scoring. */
export function crossSectionPreprocessSql(valueSql: string): string {
  const clipped = `GREATEST(
    QUANTILE_CONT(${valueSql}, 0.01) OVER (PARTITION BY tradeDate),
    LEAST(${valueSql}, QUANTILE_CONT(${valueSql}, 0.99) OVER (PARTITION BY tradeDate))
  )`;
  return `((${clipped}) - AVG(${clipped}) OVER (PARTITION BY tradeDate))
    / NULLIF(STDDEV_SAMP(${clipped}) OVER (PARTITION BY tradeDate), 0)`;
}

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { financialReports, instruments } from '../../db/schema.js';

export interface LocalFinancialReport {
  reportPeriod: string;
  announcementDate: string;
  reportType: string;
  metrics: Record<string, number | string | null>;
}

export async function getLatestFinancialReports(
  inputSymbol: string,
  limit = 8,
): Promise<LocalFinancialReport[]> {
  const symbol = inputSymbol.replace(/\D/g, '').padStart(6, '0').slice(-6);
  const rows = await getDb()
    .select({
      reportPeriod: financialReports.reportPeriod,
      announcementDate: financialReports.announcementDate,
      reportType: financialReports.reportType,
      totalRevenue: financialReports.totalRevenue,
      revenue: financialReports.revenue,
      netProfit: financialReports.netProfit,
      netProfitParent: financialReports.netProfitParent,
      netOperatingCashFlow: financialReports.netOperatingCashFlow,
      freeCashFlow: financialReports.freeCashFlow,
      roePct: financialReports.roePct,
      roeWeightedPct: financialReports.roeWeightedPct,
      roeCalculatedPct: financialReports.roeCalculatedPct,
      roeCalculationMethod: financialReports.roeCalculationMethod,
      grossMarginPct: financialReports.grossMarginPct,
      netMarginPct: financialReports.netMarginPct,
      debtToAssetsPct: financialReports.debtToAssetsPct,
      revenueYoyPct: financialReports.revenueYoyPct,
      netProfitYoyPct: financialReports.netProfitYoyPct,
      eps: financialReports.eps,
      bps: financialReports.bps,
      operatingCashFlowPerShare: financialReports.operatingCashFlowPerShare,
      totalAssets: financialReports.totalAssets,
      totalLiabilities: financialReports.totalLiabilities,
      sourceKey: financialReports.sourceKey,
    })
    .from(financialReports)
    .innerJoin(instruments, eq(instruments.instrumentKey, financialReports.instrumentKey))
    .where(and(eq(instruments.symbol, symbol), eq(instruments.type, 'stock')))
    .orderBy(desc(financialReports.announcementDate), desc(financialReports.reportPeriod))
    .limit(Math.max(1, Math.min(20, Math.trunc(limit))));

  return rows.map((row) => ({
    reportPeriod: row.reportPeriod,
    announcementDate: row.announcementDate,
    reportType: row.reportType,
    metrics: {
      reportPeriod: row.reportPeriod,
      announcementDate: row.announcementDate,
      revenue: row.revenue ?? row.totalRevenue,
      totalRevenue: row.totalRevenue,
      netProfit: row.netProfitParent ?? row.netProfit,
      netProfitParent: row.netProfitParent,
      operatingCashFlow: row.netOperatingCashFlow,
      freeCashFlow: row.freeCashFlow,
      roe: row.roeWeightedPct ?? row.roePct ?? row.roeCalculatedPct,
      roeReported: row.roeWeightedPct ?? row.roePct,
      roeCalculated: row.roeCalculatedPct,
      roeCalculationMethod: row.roeCalculationMethod,
      grossMargin: row.grossMarginPct,
      netMargin: row.netMarginPct,
      debtRatio: row.debtToAssetsPct,
      revenueGrowth: row.revenueYoyPct,
      netProfitGrowth: row.netProfitYoyPct,
      eps: row.eps,
      bps: row.bps,
      operatingCashPerShare: row.operatingCashFlowPerShare,
      totalAssets: row.totalAssets,
      totalLiabilities: row.totalLiabilities,
      source: row.sourceKey,
    },
  }));
}

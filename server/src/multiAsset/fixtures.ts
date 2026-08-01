import type { MultiAssetPlan, PointInTimeFeatureRow } from './schema.js';

const checksum = 'a'.repeat(64);

export const BASIC_MULTI_ASSET_PLAN: MultiAssetPlan = {
  planVersion: '1.0',
  snapshotId: 'snapshot-m4-fixture',
  snapshotChecksum: checksum,
  calendarId: 'CN_XSHG_XSHE_1D',
  universePlan: { type: 'point_in_time', datasetId: 'csi300-pit-fixture', datasetChecksum: 'b'.repeat(64) },
  featurePlan: { featureId: 'momentum_20', featureVersion: 'v1', direction: 'higher', missing: 'exclude' },
  signalPlan: { type: 'cross_sectional_rank', topN: 2, weighting: 'equal' },
  rebalancePolicy: { frequency: 'weekly', signalAt: 'close', fillAt: 'next_open' },
  portfolioPlan: { maxGrossExposure: 0.9, maxSingleWeight: 0.5, minCashWeight: 0.1, lotSize: 100 },
  executionPlan: { commissionRate: 0.0003, minimumCommission: 5, sellTaxRate: 0.0005, slippageRate: 0.001 },
};

export const BASIC_POINT_IN_TIME_ROWS: PointInTimeFeatureRow[] = [
  { decisionDate: '2026-07-02', executableFrom: '2026-07-03', instrumentKey: '000001.SZ', memberFrom: '2025-01-01', memberTo: null, featureValue: 0.10 },
  { decisionDate: '2026-07-02', executableFrom: '2026-07-03', instrumentKey: '000002.SZ', memberFrom: '2025-01-01', memberTo: null, featureValue: 0.20 },
  { decisionDate: '2026-07-02', executableFrom: '2026-07-03', instrumentKey: '600000.SH', memberFrom: '2025-01-01', memberTo: null, featureValue: 0.30 },
  { decisionDate: '2026-07-09', executableFrom: '2026-07-10', instrumentKey: '000001.SZ', memberFrom: '2025-01-01', memberTo: null, featureValue: 0.40 },
  { decisionDate: '2026-07-09', executableFrom: '2026-07-10', instrumentKey: '000002.SZ', memberFrom: '2025-01-01', memberTo: '2026-07-05', featureValue: 99 },
  { decisionDate: '2026-07-09', executableFrom: '2026-07-10', instrumentKey: '600000.SH', memberFrom: '2025-01-01', memberTo: null, featureValue: 0.20 },
  { decisionDate: '2026-07-09', executableFrom: '2026-07-10', instrumentKey: '600001.SH', memberFrom: '2026-07-06', memberTo: null, featureValue: 0.30 },
];

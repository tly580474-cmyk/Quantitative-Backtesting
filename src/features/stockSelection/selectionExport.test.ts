import { describe, expect, it } from 'vitest';
import type {
  Csi1000LowPbSelectionHistory,
  FactorSelectionHistory,
  MarketScreenerCriteria,
  MarketScreenerSnapshot,
} from '../marketData/types';
import {
  buildCsi1000LowPbSelectionMarkdown,
  buildFactorSelectionMarkdown,
  buildTechnicalSelectionMarkdown,
} from './selectionExport';

const criteria: MarketScreenerCriteria = {
  markets: ['SH', 'SZ'],
  minChangePct: 0,
  maxChangePct: 7,
  minAmountYi: 1,
  minTurnoverPct: 0,
  minVolumeRatio: 0,
  maxAmplitudePct: 15,
  excludeRiskNames: true,
  trend: 'bullish',
  returnPeriod: 20,
  minPeriodReturn: -30,
  maxPeriodReturn: 30,
  streakDirection: 'any',
  minStreakDays: 2,
  minRsi: 0,
  maxRsi: 100,
  kdjSignal: 'golden',
  macdSignal: 'any',
  limit: 50,
};

describe('selection export', () => {
  it('includes the technical snapshot, conditions and full signal details in Markdown', () => {
    const snapshot: MarketScreenerSnapshot = {
      totalScanned: 5544,
      totalEnriched: 239,
      updatedAt: '2026-09-02T10:30:00.000Z',
      items: [{
        code: '000001', name: '平安|银行', market: 'SZ', type: 'stock',
        price: 12.34, changePct: 1.2, amountYi: 10, turnoverPct: 2,
        amplitudePct: 3, volumeRatio: 1.1, technicalScore: 88,
        matchedSignals: ['均线多头', 'KDJ 金叉'],
        indicators: {
          asOf: '2026-09-02', close: 12.34, ma5: 12, ma10: 11, ma20: 10, ma60: 9,
          trend: 'bullish', return5d: 1, return10d: 2, return20d: 3, streak: 2,
          rsi14: 61, kdjK: 70, kdjD: 60, kdjJ: 90, kdjSignal: 'golden',
          macdDif: 0.2, macdDea: 0.1, macdHistogram: 0.2, macdSignal: 'golden',
        },
      }],
    };

    const markdown = buildTechnicalSelectionMarkdown(snapshot, criteria);
    expect(markdown).toContain('# 技术选股结果');
    expect(markdown).toContain('扫描数量：5544 只');
    expect(markdown).toContain('| 市场 | SH、SZ |');
    expect(markdown).toContain('| 排除 ST / 退市风险名称 | 是 |');
    expect(markdown).toContain('平安\\|银行');
    expect(markdown).toContain('均线多头；KDJ 金叉');
  });

  it('exports the chosen factor batch rather than only the visible table page', () => {
    const history: FactorSelectionHistory = {
      strategy: '13因子-中性化', snapshotId: 'snapshot-1',
      snapshotCreatedAt: '2026-09-02T08:00:00.000Z', dataAsOf: '2026-09-02',
      generatedAt: '2026-09-02T09:00:00.000Z',
      methodology: {
        factorCount: 13, minimumFactorCount: 8, selectionSize: 100,
        retainedSessions: 6, processing: ['去极值', '标准化', '中性化'],
      },
      batches: [],
    };
    const batch = {
      tradeDate: '2026-09-01', isLatest: false, averageReturnPct: 1.25, positiveCount: 1,
      items: [{
        rank: 1, code: '600000', name: '浦发银行', market: 'SH' as const,
        industry: '银行', selectionScore: 1.23456, factorCount: 13,
        selectedPrice: 10, latestPrice: 10.5, returnSinceSelectionPct: 5,
        financialAsOf: '2026-06-30',
      }],
    };

    const markdown = buildFactorSelectionMarkdown(history, batch);
    expect(markdown).toContain('选股日期：2026-09-01');
    expect(markdown).toContain('处理流程：去极值 → 标准化 → 中性化');
    expect(markdown).toContain('| 1 | 600000 | 浦发银行 | SH | 银行 | 1.2346 | 13 / 13 |');
  });

  it('exports CSI 1000 low-PB methodology, provenance, risk, and holdings', () => {
    const history: Csi1000LowPbSelectionHistory = {
      strategy: '中证1000低PB', snapshotId: 'research-snapshot',
      snapshotCreatedAt: '2026-09-04T14:26:11.928Z', dataAsOf: '2026-09-04',
      generatedAt: '2026-09-05T09:00:00.000Z',
      methodology: {
        indexCode: '000852', indexName: '中证1000', selectionSize: 200,
        retainedMonths: 6, rebalance: '月末', weighting: '等权',
        processing: ['锁定月末真实成分快照', '按PB升序取前200只'],
        caveats: ['结果未计交易成本与冲击成本', '历史回测不代表未来表现'],
      },
      batches: [],
    };
    const batch = {
      rebalanceDate: '2026-08-31', constituentDate: '2026-08-31',
      constituentSnapshotId: 'constituent-snapshot', isLatest: true,
      averagePb: 0.82, averageReturnPct: 1.5, positiveCount: 1,
      items: [{
        rank: 1, code: '600000', name: '浦发银行', market: 'SH' as const,
        industry: '银行', pb: 0.65, totalMarketCapYi: 3200,
        portfolioWeightPct: 0.5, selectedPrice: 10, latestPrice: 10.3,
        returnSinceSelectionPct: 3,
      }],
    };

    const markdown = buildCsi1000LowPbSelectionMarkdown(history, batch);
    expect(markdown).toContain('# 中证1000低PB选股结果');
    expect(markdown).toContain('成分日期：2026-08-31');
    expect(markdown).toContain('结果未计交易成本与冲击成本；历史回测不代表未来表现');
    expect(markdown).toContain('| 1 | 600000 | 浦发银行 | SH | 银行 | 0.650 | 3200.00 | 0.50% |');
  });
});

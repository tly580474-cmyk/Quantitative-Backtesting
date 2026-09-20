import { describe, expect, it } from 'vitest';
import { fundFlowAmountMismatch, fundFlowEvidence, verifiedFundFlowReport } from './fundFlowReportGuard.js';
import { parseStreamLine } from './outputParser.js';

export const fundFlowFixture = {
  kind: 'research-data', dataset: 'fund_flows', ok: true, usable: true, unit: '亿元',
  requested: { group: 'stock' }, windowComplete: true,
  daily: [{ tradeDate: '2026-09-14', mainNetInYi: -165.25560431, sampleCount: 5207, expectedCount: 5550 }],
  topInflow: [{ symbol: '688802', name: '沐曦股份', mainNetInYi: 34.17, daysCovered: 1 }],
  topOutflow: [{ symbol: '300750', name: '宁德时代', mainNetInYi: -63.79, daysCovered: 1 }],
  source: { providers: [{ sourceKey: 'akshare_eastmoney', sourceVersion: 'today', latestFetchedAtShanghai: '2026-09-18T17:20:08+08:00' }] },
};
const table = (amount: string, unit = '亿元') => `| 业务日期 | 主力净额（${unit}） | 样本数 |\n|---|---:|---:|\n| 2026-09-14 | ${amount} | 5,207 |`;

describe('fund flow amount consistency', () => {
  it('detects the real tenfold transcription error while allowing normal rounding', () => {
    const evidence = fundFlowEvidence(JSON.stringify(fundFlowFixture))!;
    expect(fundFlowAmountMismatch(table('-16.53'), evidence)).toBe(true);
    expect(fundFlowAmountMismatch(table('−165.26'), evidence)).toBe(false);
    expect(fundFlowAmountMismatch(table('-1652556.04', '万元'), evidence)).toBe(false);
    expect(fundFlowAmountMismatch('没有日期金额表的普通回答', evidence)).toBe(false);
    expect(verifiedFundFlowReport(evidence)).toContain('-165.26');
    expect(verifiedFundFlowReport(evidence)).toContain('17:20:08+08:00');
  });
  it('retains allowlisted evidence before truncation without arbitrary tool payloads', () => {
    const data = { ...fundFlowFixture, ignored: 'x'.repeat(20000) };
    const [event] = parseStreamLine(JSON.stringify({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'data', content: JSON.stringify(data),
    }] } }));
    expect(event.toolResult).toContain('内容已截断');
    expect(event.toolFundFlowEvidence?.daily[0].net).toBe(-165.25560431);
    expect(JSON.stringify(event.toolFundFlowEvidence)).not.toContain('ignored');
  });
  it('does not trust malformed, non-fund or unsupported industry envelopes', () => {
    expect(fundFlowEvidence({ ...fundFlowFixture, dataset: 'other' })).toBeUndefined();
    expect(fundFlowEvidence({ ...fundFlowFixture, requested: { group: 'industry' } })).toBeUndefined();
    expect(fundFlowEvidence({ ...fundFlowFixture, daily: [{ tradeDate: '2026-09-14', mainNetInYi: 'bad' }] })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { buildStructuredReport, renderExperimentMarkdown } from './report.js';

describe('experiment report', () => {
  it('makes every metric traceable to a path and calculator version', () => {
    const report = buildStructuredReport({
      runId: 'run', experimentVersionId: 'version', generatedAt: '2026-08-01T00:00:00.000Z',
      strategyName: '策略', specHash: 'spec', compilerVersion: 'compiler', dataset: {}, execution: {},
      metrics: { totalReturn: 0.12 }, validationStatus: 'candidate', policyVersion: 'policy', checks: [],
      resultHash: 'result', evaluationHash: 'evaluation',
    });
    expect(report.metrics[0]).toMatchObject({ sourcePath: '$.backtestResult.metrics.totalReturn' });
    expect(report.metrics[0].calculatorVersion).toBeTruthy();
    expect(renderExperimentMarkdown(report)).toContain('回测结果哈希');
  });
});

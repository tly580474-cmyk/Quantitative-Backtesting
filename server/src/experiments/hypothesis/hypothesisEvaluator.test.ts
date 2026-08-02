import { describe, expect, it } from 'vitest';
import type { EventEngineResult } from '../m5/eventEngineRuntime.js';
import { evaluateHypothesis, type HypothesisEvaluationDeps } from './hypothesisEvaluator.js';
import {
  evaluateHypothesisRequestSchema,
  hypothesisPlanSchema,
  hypothesisRecordSchema,
  type HypothesisPlan,
  type HypothesisRecord,
} from './hypothesisSchema.js';

const plan: HypothesisPlan = hypothesisPlanSchema.parse({
  protocolVersion: '1.0',
  strategyType: 'dual_ma',
  params: { fast: 5, slow: 20 },
  name: '双均线交叉 5/20 日',
  description: '短期均线上穿长期均线买入，下穿卖出',
  rationale: '趋势跟踪',
  capabilityVersion: 'test-capabilities-v1',
});

const draftHypothesis: HypothesisRecord = hypothesisRecordSchema.parse({
  id: '7f9e1a2b-3c4d-4e6f-8a8b-9c0d1e2f3a4b',
  plan,
  status: 'draft',
  mappedExperimentVersionId: null,
  lastRunId: null,
  validationStatus: null,
  evaluationSummary: null,
  rejectionReason: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
});

const request = evaluateHypothesisRequestSchema.parse({
  datasetSnapshot: {
    id: 'ds-1',
    name: '000001 日线',
    symbol: '000001',
    startTime: '2026-06-01',
    endTime: '2026-06-30',
    checksum: 'abc123',
  },
  candles: [
    { time: '2026-06-01', open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000 },
    { time: '2026-06-02', open: 10.5, high: 11.5, low: 10, close: 11, volume: 1200 },
    { time: '2026-06-03', open: 11, high: 12, low: 10.5, close: 11.8, volume: 1500 },
  ],
  config: {
    backtestMode: 'strategy',
    initialCapital: 100_000,
    tradingDays: 20,
    positionSizing: { type: 'percent', value: 0.5 },
    commissionRate: 0.0003,
    minimumCommission: 5,
    sellTaxRate: 0.001,
    slippageBps: 5,
    tradingUnitMode: 'stock',
    minimumTradeAmount: 100,
    dca: { amount: 0, frequency: 'daily' },
    execution: 'next_open',
    forceCloseAtEnd: true,
  },
  engineVersion: 'backtrader-event-engine-v1',
});

function mockEngineResult(finalEquity: number): EventEngineResult {
  return {
    protocolVersion: '1.0',
    runtime: 'backtrader',
    authority: 'screening_only',
    publishable: false,
    trades: [],
    orders: [],
    equityCurve: [],
    finalEquity,
  };
}

describe('N3.3 hypothesis evaluation orchestration', () => {
  it('runs the full M2 chain with mock deps and marks the hypothesis evaluated', async () => {
    const captured: Record<string, unknown> = {};
    const deps: HypothesisEvaluationDeps = {
      confirmVersion: async () => ({ experimentVersion: { id: '11111111-1111-4111-8111-111111111111' }, reused: false }),
      createRun: async (input) => {
        captured.createRun = input;
        return { conflict: false, run: { id: '22222222-2222-4222-8222-222222222222' }, reused: false };
      },
      runBacktest: async () => mockEngineResult(110_000),
      persistBacktestResult: async (result) => {
        captured.result = result;
      },
      completeRun: async (runId, input) => {
        captured.complete = { runId, input };
        return { type: 'completed' };
      },
      validateRun: async (runId) => {
        captured.validateRun = runId;
        return {};
      },
      getRun: async () => ({ validationStatus: 'candidate' }),
      markEvaluated: async (input) => hypothesisRecordSchema.parse({
        ...draftHypothesis,
        status: 'evaluated',
        ...input,
        updatedAt: '2026-08-02T01:00:00.000Z',
      }),
    };

    const outcome = await evaluateHypothesis({
      hypothesisId: draftHypothesis.id,
      plan,
      request,
      deps,
    });

    expect(outcome.hypothesis.status).toBe('evaluated');
    expect(outcome.experimentVersionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(outcome.runId).toBe('22222222-2222-4222-8222-222222222222');
    expect(outcome.validationStatus).toBe('candidate');
    expect(outcome.evaluationSummary.authority).toBe('screening_only');
    expect(outcome.evaluationSummary.totalReturn).toBeCloseTo(0.1);

    const createRun = captured.createRun as {
      runtime: string;
      idempotencyKey: string;
      strategyParams: Record<string, number>;
    };
    expect(createRun.runtime).toBe('backend_event_engine');
    expect(createRun.idempotencyKey).toMatch(/^hypothesis:7f9e1a2b-3c4d-4e6f-8a8b-9c0d1e2f3a4b:[a-f0-9]{64}$/);
    expect(createRun.strategyParams).toEqual({ fast: 5, slow: 20 });

    const result = captured.result as { strategyId: string; strategyVersion: string; id: string };
    expect(result.strategyId).toBe('hypothesis:dual_ma');
    expect(result.strategyVersion).toBe('1');

    const complete = captured.complete as { input: { resultHash: string } };
    expect(complete.input.resultHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('surfaces a result hash mismatch', async () => {
    const deps: HypothesisEvaluationDeps = {
      confirmVersion: async () => ({ experimentVersion: { id: 'ver-1' }, reused: false }),
      createRun: async () => ({ conflict: false, run: { id: 'run-1' }, reused: false }),
      runBacktest: async () => mockEngineResult(100_000),
      persistBacktestResult: async () => undefined,
      completeRun: async () => ({ type: 'hash_mismatch' }),
      validateRun: async () => ({}),
      getRun: async () => ({ validationStatus: null }),
      markEvaluated: async (input) => hypothesisRecordSchema.parse({
        ...draftHypothesis,
        status: 'evaluated',
        ...input,
      }),
    };
    await expect(evaluateHypothesis({
      hypothesisId: draftHypothesis.id,
      plan,
      request,
      deps,
    })).rejects.toThrow('RESULT_HASH_MISMATCH');
  });

  it('wraps backtest engine failures as HYPOTHESIS_BACKTEST_FAILED', async () => {
    const deps: HypothesisEvaluationDeps = {
      confirmVersion: async () => ({ experimentVersion: { id: 'ver-1' }, reused: false }),
      createRun: async () => ({ conflict: false, run: { id: 'run-1' }, reused: false }),
      runBacktest: async () => { throw new Error('EVENT_ENGINE_WORKER_FAILED:1'); },
      persistBacktestResult: async () => undefined,
      completeRun: async () => ({ type: 'completed' }),
      validateRun: async () => ({}),
      getRun: async () => ({ validationStatus: null }),
      markEvaluated: async (input) => hypothesisRecordSchema.parse({
        ...draftHypothesis,
        status: 'evaluated',
        ...input,
      }),
    };
    await expect(evaluateHypothesis({
      hypothesisId: draftHypothesis.id,
      plan,
      request,
      deps,
    })).rejects.toThrow('HYPOTHESIS_BACKTEST_FAILED');
  });
});

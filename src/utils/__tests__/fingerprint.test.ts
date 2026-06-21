import { describe, it, expect } from 'vitest';
import { createExperimentFingerprint } from '../fingerprint';
import type { BacktestConfig } from '@/models';

const baseConfig: BacktestConfig = {
  backtestMode: 'strategy',
  initialCapital: 100000,
  tradingDays: 0,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 10,
  tradingUnitMode: 'index',
  minimumTradeAmount: 1,
  dca: { amount: 1000, frequency: 'monthly' },
  execution: 'next_open',
  forceCloseAtEnd: true,
};

describe('createExperimentFingerprint', () => {
  const baseInput = {
    dataChecksum: 'abc123',
    config: baseConfig,
    strategyId: 'dual-ma',
    strategyVersion: '1.0.0',
    strategyParams: { shortPeriod: 5, longPeriod: 20 },
  };

  it('returns stable fingerprint for same inputs', () => {
    const f1 = createExperimentFingerprint(baseInput);
    const f2 = createExperimentFingerprint(baseInput);
    expect(f1.fingerprint).toBe(f2.fingerprint);
  });

  it('changes fingerprint when data checksum changes', () => {
    const f1 = createExperimentFingerprint(baseInput);
    const f2 = createExperimentFingerprint({ ...baseInput, dataChecksum: 'xyz789' });
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });

  it('changes fingerprint when config changes', () => {
    const f1 = createExperimentFingerprint(baseInput);
    const f2 = createExperimentFingerprint({
      ...baseInput,
      config: { ...baseConfig, initialCapital: 200000 },
    });
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });

  it('changes fingerprint when strategy params change', () => {
    const f1 = createExperimentFingerprint(baseInput);
    const f2 = createExperimentFingerprint({
      ...baseInput,
      strategyParams: { shortPeriod: 10, longPeriod: 20 },
    });
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });

  it('includes all component fields', () => {
    const f = createExperimentFingerprint(baseInput);
    expect(f.components.engineVersion).toBeTruthy();
    expect(f.components.dataChecksum).toBe('abc123');
    expect(f.components.configHash).toBeTruthy();
    expect(f.components.strategyHash).toBeTruthy();
    expect(f.components.parameterHash).toBeTruthy();
  });

  it('fingerprint value is non-empty', () => {
    const f = createExperimentFingerprint(baseInput);
    expect(f.fingerprint).toBeTruthy();
    expect(typeof f.fingerprint).toBe('string');
  });
});

import { describe, expect, it } from 'vitest';
import { listBuiltinFactors, requireBuiltinFactor, validateFactorRunConfig } from './validator.js';

describe('factor definition validator', () => {
  it('lists only builtin whitelist factors', () => {
    const ids = listBuiltinFactors().map((factor) => factor.id);
    expect(ids).toContain('momentum_20');
    expect(ids).toContain('atr_14');
  });

  it('rejects unknown factor expressions', () => {
    expect(() => requireBuiltinFactor('drop_table')).toThrow('不支持的内置因子');
  });

  it('normalizes run config and validates boundaries', () => {
    expect(validateFactorRunConfig({
      factorId: 'momentum_20',
      startDate: '2026-01-01',
      endDate: '2026-03-01',
      horizonDays: 5,
      layers: 5,
      markets: ['SH', 'SH', ''],
    }).markets).toEqual(['SH']);

    expect(() => validateFactorRunConfig({
      factorId: 'momentum_20',
      startDate: '2026-03-01',
      endDate: '2026-01-01',
      horizonDays: 5,
      layers: 5,
    })).toThrow('研究开始日期不能晚于结束日期');
  });
});

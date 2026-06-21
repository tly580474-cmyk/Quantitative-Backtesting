import { describe, it, expect } from 'vitest';
import { createSeededRandom, seedToInt32 } from '../random';

describe('seedToInt32', () => {
  it('returns consistent results for same seed', () => {
    expect(seedToInt32('hello')).toBe(seedToInt32('hello'));
  });

  it('produces different results for different seeds', () => {
    expect(seedToInt32('hello')).not.toBe(seedToInt32('world'));
  });

  it('returns a 32-bit integer', () => {
    const val = seedToInt32('test');
    expect(Number.isInteger(val)).toBe(true);
  });
});

describe('createSeededRandom', () => {
  it('produces deterministic sequences', () => {
    const r1 = createSeededRandom('fixed-seed');
    const r2 = createSeededRandom('fixed-seed');
    const seq1 = Array.from({ length: 20 }, () => r1.next());
    const seq2 = Array.from({ length: 20 }, () => r2.next());
    expect(seq1).toEqual(seq2);
  });

  it('produces different sequences for different seeds', () => {
    const r1 = createSeededRandom('seed-a');
    const r2 = createSeededRandom('seed-b');
    const v1 = r1.next();
    const v2 = r2.next();
    expect(v1).not.toBe(v2);
  });

  it('next returns values in [0, 1)', () => {
    const r = createSeededRandom('range-test');
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt returns integers in [min, max]', () => {
    const r = createSeededRandom('int-test');
    for (let i = 0; i < 500; i++) {
      const v = r.nextInt(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('clone produces identical subsequent values', () => {
    const r1 = createSeededRandom('clone-test');
    // Advance r1 a few steps
    for (let i = 0; i < 10; i++) r1.next();

    const r2 = r1.clone();
    const seq1 = Array.from({ length: 10 }, () => r1.next());
    const seq2 = Array.from({ length: 10 }, () => r2.next());
    expect(seq1).toEqual(seq2);
  });

  it('empty string seed works', () => {
    const r = createSeededRandom('');
    expect(r.next()).toBeGreaterThanOrEqual(0);
    expect(r.next()).toBeLessThan(1);
  });
});

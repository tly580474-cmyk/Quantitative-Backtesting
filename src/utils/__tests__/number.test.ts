import { describe, it, expect } from 'vitest';
import { parseNumber, parsePercentPoints, roundTo } from '../number';

describe('parseNumber', () => {
  it('parses regular number string', () => {
    expect(parseNumber('123.45')).toBe(123.45);
  });

  it('parses integer', () => {
    expect(parseNumber('1000')).toBe(1000);
  });

  it('parses negative number', () => {
    expect(parseNumber('-50.5')).toBe(-50.5);
  });

  it('handles commas in numbers', () => {
    expect(parseNumber('1,234,567.89')).toBe(1234567.89);
  });

  it('handles spaces in numbers', () => {
    expect(parseNumber('1 234 567.89')).toBe(1234567.89);
  });

  it('returns NaN for non-numeric string', () => {
    expect(parseNumber('abc')).toBeNaN();
  });

  it('returns NaN for empty string', () => {
    expect(parseNumber('')).toBeNaN();
  });

  it('returns NaN for null', () => {
    expect(parseNumber(null)).toBeNaN();
  });

  it('returns NaN for undefined', () => {
    expect(parseNumber(undefined)).toBeNaN();
  });

  it('returns number directly if already numeric', () => {
    expect(parseNumber(42)).toBe(42);
  });

  it('returns NaN for Infinity', () => {
    expect(parseNumber(Infinity)).toBeNaN();
  });
});

describe('parsePercentPoints', () => {
  it('normalizes values with and without a percent sign', () => {
    expect(parsePercentPoints('0.72')).toBe(0.72);
    expect(parsePercentPoints('0.72%')).toBeCloseTo(0.72, 10);
    expect(parsePercentPoints('-1.25%')).toBeCloseTo(-1.25, 10);
  });
});

describe('roundTo', () => {
  it('rounds to specified decimal places', () => {
    expect(roundTo(3.14159, 2)).toBe(3.14);
  });

  it('rounds up correctly', () => {
    expect(roundTo(3.145, 2)).toBe(3.15);
  });

  it('returns integer when decimals is 0', () => {
    expect(roundTo(3.7, 0)).toBe(4);
  });
});

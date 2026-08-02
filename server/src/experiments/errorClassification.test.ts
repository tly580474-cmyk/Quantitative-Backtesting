import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StrategyOutputValidationError } from '../services/strategyGeneration/schema.js';
import {
  classifyRunFailure,
  classifyStrategyOutputError,
  EXPERIMENT_ERROR_CATEGORY_META,
  experimentErrorCategories,
} from './errorClassification.js';

describe('N4.1 error classification', () => {
  it('covers the nine categories from the design doc plus INTERNAL_ERROR', () => {
    expect(experimentErrorCategories).toEqual([
      'SCHEMA_INVALID',
      'SEMANTIC_CONFLICT',
      'UNSUPPORTED_CAPABILITY',
      'COMPILE_FAILED',
      'DATA_MISSING',
      'DATA_QUALITY_FAILED',
      'RESOURCE_EXCEEDED',
      'RUNTIME_FAILED',
      'VALIDATION_FAILED',
      'INTERNAL_ERROR',
    ]);
    for (const category of experimentErrorCategories) {
      expect(EXPERIMENT_ERROR_CATEGORY_META[category].label.length).toBeGreaterThan(0);
      expect(EXPERIMENT_ERROR_CATEGORY_META[category].userAction.length).toBeGreaterThan(0);
    }
  });

  it('maps a StrategyOutputValidationError to SCHEMA_INVALID with field paths', () => {
    const error = new StrategyOutputValidationError(['entry.left: 引用了未声明指标 fast_ma', 'parameters.0.name: 参数未被引用']);
    const payload = classifyStrategyOutputError(error);
    expect(payload.category).toBe('SCHEMA_INVALID');
    expect(payload.code).toBe('SCHEMA_INVALID');
    expect(payload.fieldPaths).toEqual(['entry.left', 'parameters.0.name']);
    expect(payload.issues).toHaveLength(2);
  });

  it('maps a ZodError to SCHEMA_INVALID', () => {
    const schema = z.object({ name: z.string() });
    const parsed = schema.safeParse({ name: 123 });
    if (parsed.success) throw new Error('expected failure');
    const payload = classifyStrategyOutputError(parsed.error);
    expect(payload.category).toBe('SCHEMA_INVALID');
    expect(payload.fieldPaths).toContain('name');
  });

  it('buckets unknown exceptions as INTERNAL_ERROR (never downgraded)', () => {
    const payload = classifyStrategyOutputError(new Error('boom'));
    expect(payload.category).toBe('INTERNAL_ERROR');
    expect(payload.retryable === undefined || payload.category === 'INTERNAL_ERROR').toBe(true);
  });

  it('maps run failure codes onto categories', () => {
    expect(classifyRunFailure('SCHEMA_INVALID')).toBe('SCHEMA_INVALID');
    expect(classifyRunFailure('VALIDATION_FAILED')).toBe('VALIDATION_FAILED');
    expect(classifyRunFailure('DATA_MISSING')).toBe('DATA_MISSING');
    expect(classifyRunFailure('WEIRD_CODE')).toBe('INTERNAL_ERROR');
  });

  it('marks VALIDATION_FAILED as non-retryable business outcome', () => {
    expect(EXPERIMENT_ERROR_CATEGORY_META.VALIDATION_FAILED.retryable).toBe(false);
    expect(EXPERIMENT_ERROR_CATEGORY_META.UNSUPPORTED_CAPABILITY.retryable).toBe(false);
    expect(EXPERIMENT_ERROR_CATEGORY_META.SCHEMA_INVALID.retryable).toBe(true);
  });
});

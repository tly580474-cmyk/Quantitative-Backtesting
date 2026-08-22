import { describe, expect, it } from 'vitest';
import { getAiModelListValidationError, parseAiModelList } from './aiModelList.js';

describe('AI model list', () => {
  it('parses a semicolon-delimited list in configured order', () => {
    expect(parseAiModelList('model-1; provider/model-2 ;model-3')).toEqual([
      'model-1',
      'provider/model-2',
      'model-3',
    ]);
  });

  it('keeps a single model backward compatible', () => {
    expect(parseAiModelList('provider/free')).toEqual(['provider/free']);
  });

  it('rejects empty and duplicate model entries', () => {
    expect(getAiModelListValidationError('model-1;;model-2')).toContain('空模型项');
    expect(getAiModelListValidationError('model-1;model-1')).toContain('重复');
  });
});

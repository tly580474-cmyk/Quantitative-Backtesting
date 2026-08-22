import { describe, expect, it } from 'vitest';
import { sanitizeSecretReplacement } from './secretInput';

describe('secret replacement input', () => {
  it('blocks the active admin token from entering a business secret field', () => {
    expect(sanitizeSecretReplacement('admin-secret', 'admin-secret')).toEqual({
      value: '',
      blocked: true,
    });
  });

  it('allows a distinct provider key and does not treat two empty values as a credential leak', () => {
    expect(sanitizeSecretReplacement('provider-key', 'admin-secret')).toEqual({
      value: 'provider-key',
      blocked: false,
    });
    expect(sanitizeSecretReplacement('', '')).toEqual({ value: '', blocked: false });
  });
});

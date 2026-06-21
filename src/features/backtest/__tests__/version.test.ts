import { describe, it, expect } from 'vitest';
import { ENGINE_VERSION } from '../version';

describe('ENGINE_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof ENGINE_VERSION).toBe('string');
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
  });

  it('follows semver format', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

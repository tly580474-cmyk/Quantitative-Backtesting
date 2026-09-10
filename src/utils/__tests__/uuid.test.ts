import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuid } from '../uuid';

describe('createUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses a fallback when randomUUID is unavailable on an HTTP LAN origin', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(1);
        return bytes;
      },
    });

    expect(createUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

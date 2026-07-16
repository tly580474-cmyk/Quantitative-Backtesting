import { describe, expect, it } from 'vitest';
import {
  INDEXEDDB_READONLY_ERROR,
  rejectIndexedDbMutation,
} from '../indexeddbRepo';

describe('IndexedDB migration repository', () => {
  it('rejects every write through the shared read-only guard', async () => {
    await expect(rejectIndexedDbMutation()).rejects.toThrow(INDEXEDDB_READONLY_ERROR);
  });
});

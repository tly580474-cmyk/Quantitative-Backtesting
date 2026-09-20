import { afterEach, expect, it, vi } from 'vitest';
import { downloadDatabaseBackupExport } from './api';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; vi.useRealTimers(); });

it('hands a one-time ticket to a native form download without fetching backup bytes', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => ({ ticket: 'one-time-ticket' }) }));
  vi.stubGlobal('fetch', fetchMock);
  let submitted: HTMLFormElement | undefined;
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) { submitted = this; });
  await downloadDatabaseBackupExport('admin-credential', 'backup-id', 'large.sql');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toContain('/download-ticket');
  expect(submitted?.method.toLowerCase()).toBe('post');
  expect(submitted?.action).toContain('/backup-id/download');
  expect(submitted?.outerHTML).toContain('one-time-ticket');
  expect(submitted?.outerHTML).not.toContain('admin-credential');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(document.querySelector('iframe')).toBeNull();
});

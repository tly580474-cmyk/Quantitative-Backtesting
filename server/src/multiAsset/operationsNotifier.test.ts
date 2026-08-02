import { describe, expect, it, vi } from 'vitest';
import type { MultiAssetOperationalStatus } from './operations.js';
import { deliverMultiAssetOperationalAlert } from './operationsNotifier.js';

const status = (level: MultiAssetOperationalStatus['level']): MultiAssetOperationalStatus => ({
  level,
  checkedAt: '2026-08-02T00:00:00.000Z',
  alerts: level === 'healthy' ? [] : [{ code: 'DRILL', level, message: 'drill' }],
  queue: { counts: {}, oldestWaitingSeconds: null, expiredRunningLeases: 0 },
  workers: { fresh: 2, stale: 0, stopped: 0, capacity: 4, entries: [] },
  artifacts: { count: 3, bytes: 100 },
});

describe('multi-asset operations notifier', () => {
  it('does not notify healthy state by default', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(deliverMultiAssetOperationalAlert(status('healthy'), {
      webhookUrl: '', timeoutMs: 100, fetchImpl,
    })).resolves.toEqual({ attempted: false, delivered: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delivers warning and critical payloads to an HTTPS webhook', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deliverMultiAssetOperationalAlert(status('critical'), {
      webhookUrl: 'https://monitor.example.test/hook', bearerToken: 'secret', timeoutMs: 100, fetchImpl,
    })).resolves.toEqual({ attempted: true, delivered: true, statusCode: 204 });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      event: 'multi_asset_operational_status', severity: 'critical',
    });
  });

  it('rejects plaintext non-loopback endpoints', async () => {
    await expect(deliverMultiAssetOperationalAlert(status('warning'), {
      webhookUrl: 'http://monitor.example.test/hook', timeoutMs: 100,
    })).rejects.toThrow('MULTI_ASSET_ALERT_WEBHOOK_REQUIRES_HTTPS');
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateMultiAssetOperationalAlerts } from './operations.js';

describe('multi-asset operational alert policy', () => {
  const base = {
    waiting: 0,
    freshWorkers: 1,
    staleWorkers: 0,
    expiredRunningLeases: 0,
    oldestWaitingSeconds: null,
    queueWarningSeconds: 60,
    queueCriticalSeconds: 300,
  };

  it('is healthy when workers are fresh and the queue has no aged work', () => {
    expect(evaluateMultiAssetOperationalAlerts(base)).toEqual({ level: 'healthy', alerts: [] });
  });

  it('warns on an aged queue and becomes critical at the hard threshold', () => {
    expect(evaluateMultiAssetOperationalAlerts({ ...base, waiting: 1, oldestWaitingSeconds: 60 }))
      .toMatchObject({ level: 'warning', alerts: [{ code: 'QUEUE_WAIT_WARNING' }] });
    expect(evaluateMultiAssetOperationalAlerts({ ...base, waiting: 1, oldestWaitingSeconds: 300 }))
      .toMatchObject({ level: 'critical', alerts: [{ code: 'QUEUE_WAIT_CRITICAL' }] });
  });

  it('is critical when work is waiting without a fresh worker or leases expire', () => {
    const result = evaluateMultiAssetOperationalAlerts({
      ...base,
      waiting: 2,
      freshWorkers: 0,
      staleWorkers: 1,
      expiredRunningLeases: 1,
    });
    expect(result.level).toBe('critical');
    expect(result.alerts.map((alert) => alert.code)).toEqual([
      'EXPIRED_RUNNING_LEASES', 'STALE_WORKERS', 'NO_ACTIVE_WORKER',
    ]);
  });
});

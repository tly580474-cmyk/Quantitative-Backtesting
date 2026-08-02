import type { MultiAssetOperationalStatus } from './operations.js';

export interface MultiAssetAlertDeliveryResult {
  attempted: boolean;
  delivered: boolean;
  statusCode?: number;
}

export async function deliverMultiAssetOperationalAlert(
  status: MultiAssetOperationalStatus,
  options: {
    webhookUrl: string;
    bearerToken?: string;
    timeoutMs: number;
    notifyHealthy?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<MultiAssetAlertDeliveryResult> {
  if (status.level === 'healthy' && !options.notifyHealthy) {
    return { attempted: false, delivered: false };
  }
  if (!options.webhookUrl.trim()) throw new Error('MULTI_ASSET_ALERT_WEBHOOK_URL_REQUIRED');
  const target = new URL(options.webhookUrl);
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopback)) {
    throw new Error('MULTI_ASSET_ALERT_WEBHOOK_REQUIRES_HTTPS');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(target, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        event: 'multi_asset_operational_status',
        severity: status.level,
        checkedAt: status.checkedAt,
        alerts: status.alerts,
        queue: status.queue,
        workers: {
          fresh: status.workers.fresh,
          stale: status.workers.stale,
          stopped: status.workers.stopped,
          capacity: status.workers.capacity,
        },
        artifacts: status.artifacts,
      }),
    });
    if (!response.ok) throw new Error(`MULTI_ASSET_ALERT_DELIVERY_FAILED:${response.status}`);
    return { attempted: true, delivered: true, statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

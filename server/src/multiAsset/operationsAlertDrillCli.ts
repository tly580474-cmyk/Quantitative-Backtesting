import 'dotenv/config';
import { loadConfig } from '../config.js';
import type { MultiAssetOperationalStatus } from './operations.js';
import { deliverMultiAssetOperationalAlert } from './operationsNotifier.js';

const levelArg = process.argv.find((item) => item.startsWith('--level='))?.slice('--level='.length);
if (levelArg !== 'warning' && levelArg !== 'critical') {
  throw new Error('用法：npm run multi-asset:alert-drill -- --level=warning|critical');
}
const config = loadConfig();
const status: MultiAssetOperationalStatus = {
  level: levelArg,
  checkedAt: new Date().toISOString(),
  alerts: [{
    code: levelArg === 'critical' ? 'DRILL_CRITICAL' : 'DRILL_WARNING',
    level: levelArg,
    message: 'M4 生产告警通知链路演练，不代表真实故障',
  }],
  queue: { counts: {}, oldestWaitingSeconds: null, expiredRunningLeases: 0 },
  workers: { fresh: 2, stale: 0, stopped: 0, capacity: 2, entries: [] },
  artifacts: { count: 0, bytes: 0 },
};
const delivery = await deliverMultiAssetOperationalAlert(status, {
  webhookUrl: config.MULTI_ASSET_ALERT_WEBHOOK_URL,
  bearerToken: config.MULTI_ASSET_ALERT_WEBHOOK_BEARER_TOKEN,
  timeoutMs: Number(config.MULTI_ASSET_ALERT_TIMEOUT_MS),
});
console.log(JSON.stringify({ status, delivery }, null, 2));

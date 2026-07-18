import { createHash } from 'node:crypto';
import { parseLooseJson } from './looseJson.js';
import { limiterForHost } from './rateLimiter.js';

const CLS_URL = 'https://www.cls.cn/v1/roll/get_roll_list';

export function buildClsSignature(params: Record<string, string>): string {
  const query = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
  const sha1 = createHash('sha1').update(query).digest('hex');
  return createHash('md5').update(sha1).digest('hex');
}

export async function fetchClsTelegraph(limit = 50, lastTime = ''): Promise<unknown> {
  const params = {
    appName: 'CailianpressWeb', os: 'web', sv: '7.7.5', last_time: lastTime,
    refresh_type: '1', rn: String(Math.max(1, Math.min(100, limit))),
  };
  const target = new URL(CLS_URL);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  target.searchParams.set('sign', buildClsSignature(params));
  return limiterForHost(target.hostname).run(async () => {
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*', Referer: 'https://www.cls.cn/',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CLS HTTP ${response.status}`);
    const payload = parseLooseJson(await response.text()) as { errno?: number; msg?: string };
    if (payload.errno != null && payload.errno !== 0) throw new Error(`CLS ${payload.errno}: ${payload.msg ?? 'unknown error'}`);
    return payload;
  });
}

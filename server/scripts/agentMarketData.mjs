#!/usr/bin/env node

const BASE_URL = process.env.AGENT_MARKET_DATA_BASE_URL || 'http://127.0.0.1:3001';
const timeoutMs = 60_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parseArgs(values) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) flags.set(key, 'true');
    else {
      flags.set(key, next);
      index += 1;
    }
  }
  return { positional, flags };
}

function assertCode(value) {
  if (!/^\d{6}$/.test(value || '')) throw new Error('股票代码必须是 6 位数字');
  return value;
}

function assertDate(value, name) {
  if (value != null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} 必须为 YYYY-MM-DD`);
  return value;
}

function integer(value, fallback, min, max, name) {
  const parsed = value == null ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 必须在 ${min}-${max} 之间`);
  return parsed;
}

function query(path, values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null) params.set(key, String(value));
  const suffix = params.size ? `?${params}` : '';
  return `${path}${suffix}`;
}

const CATALOG = {
  policy: 'read-only, project-api-first',
  baseUrl: BASE_URL,
  commands: {
    health: 'health',
    search: 'search <代码|简称|拼音>',
    quote: 'quote <6位代码>',
    indices: 'indices',
    sentiment: 'sentiment',
    hotSectors: 'hot-sectors',
    kline: 'kline <代码> [--period day|week|year|intraday] [--adjustment qfq|hfq|none] [--start YYYY-MM-DD] [--end YYYY-MM-DD]',
    minute: 'minute <代码> --start YYYY-MM-DD [--end YYYY-MM-DD] [--interval 1|5|15|30|60|120] [--limit 1..10000]',
    minuteCatalog: 'minute-catalog',
    reports: 'reports <代码>',
    sevenLayer: 'seven-layer <代码> [--section signal|capital|fundamental|announcement|news]',
    stockNews: 'news-stock <代码> [--limit 1..100]',
    marketNews: 'news-market [--limit 1..100]',
    dragonTiger: 'dragon-tiger-stock <代码>',
    snapshots: 'snapshots',
  },
  fallback: 'Only use a-stock-data after this project API returns missing, empty, stale, or unsupported data.',
};

async function main() {
  const base = new URL(BASE_URL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol)) {
    throw new Error('AGENT_MARKET_DATA_BASE_URL 只允许本机回环地址');
  }
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, arg] = positional;
  if (!command || command === 'catalog') {
    process.stdout.write(`${JSON.stringify(CATALOG, null, 2)}\n`);
    return;
  }

  let path;
  switch (command) {
    case 'health': path = '/api/health'; break;
    case 'search':
      if (!arg || arg.length > 40) throw new Error('search 需要 1-40 字符查询词');
      path = query('/api/market-data/stocks/search', { q: arg });
      break;
    case 'quote': path = `/api/market-data/stocks/${assertCode(arg)}/quote`; break;
    case 'indices': path = '/api/market-data/indices/quotes'; break;
    case 'sentiment': path = '/api/market-data/market-sentiment'; break;
    case 'hot-sectors': path = '/api/market-data/hot-sectors'; break;
    case 'kline': {
      const period = flags.get('period') || 'day';
      const adjustmentMode = flags.get('adjustment') || 'qfq';
      if (!['intraday', 'day', 'week', 'year'].includes(period)) throw new Error('period 无效');
      if (!['none', 'qfq', 'hfq'].includes(adjustmentMode)) throw new Error('adjustment 无效');
      path = query(`/api/market-data/stocks/${assertCode(arg)}/kline`, {
        period, adjustmentMode, startDate: assertDate(flags.get('start'), 'start'),
        endDate: assertDate(flags.get('end'), 'end'), fullHistory: 'true', localFirst: 'true',
      });
      break;
    }
    case 'minute': {
      const startDate = assertDate(flags.get('start'), 'start');
      if (!startDate) throw new Error('minute 必须提供 --start');
      const interval = integer(flags.get('interval'), 1, 1, 120, 'interval');
      if (![1, 5, 15, 30, 60, 120].includes(interval)) throw new Error('interval 仅支持 1/5/15/30/60/120');
      path = query(`/api/market-data/stocks/${assertCode(arg)}/minute`, {
        startDate, endDate: assertDate(flags.get('end'), 'end'), interval,
        limit: integer(flags.get('limit'), 10_000, 1, 10_000, 'limit'),
      });
      break;
    }
    case 'minute-catalog': path = '/api/market-data/minute/catalog'; break;
    case 'reports': path = `/api/market-data/stocks/${assertCode(arg)}/reports`; break;
    case 'seven-layer': {
      const section = flags.get('section');
      if (section && !['signal', 'capital', 'fundamental', 'announcement', 'news'].includes(section)) throw new Error('section 无效');
      path = `/api/market-data/stocks/${assertCode(arg)}/seven-layer${section ? `/${section}` : ''}`;
      break;
    }
    case 'news-stock': path = query(`/api/market-data/news/stocks/${assertCode(arg)}`, { limit: integer(flags.get('limit'), 20, 1, 100, 'limit') }); break;
    case 'news-market': path = query('/api/market-data/news/market', { limit: integer(flags.get('limit'), 20, 1, 100, 'limit') }); break;
    case 'dragon-tiger-stock': path = `/api/market-data/dragon-tiger/stocks/${assertCode(arg)}`; break;
    case 'snapshots': path = '/api/research-snapshots/current'; break;
    default: throw new Error(`未知命令: ${command}；运行 catalog 查看支持项`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, base), { signal: controller.signal, headers: { accept: 'application/json' } });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { data = { message: body.slice(0, 1000) }; }
    if (command === 'kline' && Array.isArray(data?.items)) {
      const startDate = flags.get('start');
      const endDate = flags.get('end');
      data.items = data.items.filter(item => (!startDate || item.date >= startDate) && (!endDate || item.date <= endDate));
    }
    const output = {
      ok: response.ok,
      accessLayer: 'project-api',
      source: new URL(path, base).toString(),
      retrievedAt: new Date().toISOString(),
      status: response.status,
      data,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!response.ok) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));

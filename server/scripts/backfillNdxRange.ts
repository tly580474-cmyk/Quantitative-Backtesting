import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { closePool, createPool } from '../src/db/connection.js';
import { getDb, initDb, schema } from '../src/db/index.js';
import {
  appendDatasetCandles,
  parseTencentUsIndexDailyCandles,
} from '../src/marketData/jobs/indexDatasetUpdater.js';

const { marketDatasets } = schema;
const TENCENT_US_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get';
const TENCENT_US_KLINE_BARS = 640;

const START = process.env.NDX_START ?? '2026-06-22';
const END = process.env.NDX_END ?? '2026-09-03';

async function fetchTencentBars() {
  const params = new URLSearchParams({
    param: `usNDX,day,,,${TENCENT_US_KLINE_BARS},qfq`,
    r: Math.random().toString(),
  });
  const response = await fetch(`${TENCENT_US_KLINE_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Referer: 'https://stock.qq.com/',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`腾讯美股指数日线 HTTP ${response.status}`);
  return await response.json();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  initDb(pool);
  try {
    const db = getDb();
    const [dataset] = await db.select().from(marketDatasets).where(eq(marketDatasets.symbol, 'NDX'));
    if (!dataset) throw new Error('未找到 NDX 数据集');

    const payload = await fetchTencentBars();
    const rows = parseTencentUsIndexDailyCandles(payload, 'usNDX', 'NDX', START, END);
    if (rows.length === 0) throw new Error(`腾讯未返回 ${START}~${END} 的日线数据`);

    console.log(`[backfill] NDX ${START}~${END}: 腾讯返回 ${rows.length} 行，准备写库…`);
    await appendDatasetCandles(dataset, rows);

    const [after] = await db.select().from(marketDatasets).where(eq(marketDatasets.id, dataset.id));
    console.log(JSON.stringify({
      status: 'done',
      range: [START, END],
      replacedRows: rows.length,
      first: rows[0],
      last: rows[rows.length - 1],
      dataset: {
        startTime: after.startTime,
        endTime: after.endTime,
        count: after.count,
        sourceFileName: after.sourceFileName,
        checksum: after.checksum,
      },
    }, null, 2));
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { checkConnection, closePool, createPool } from '../db/connection.js';
import { collectAdminOverview } from './diagnostics.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const dbOnline = (await checkConnection(pool)).ok;
  const overview = await collectAdminOverview({
    pool,
    dbOnline,
    config,
    envFilePath: resolve('.env'),
  });
  console.log(JSON.stringify(overview, null, 2));
  if (overview.overall === 'critical') process.exitCode = 1;
} finally {
  await closePool(pool);
}

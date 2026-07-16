import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from './connection.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const result = await runMigrations(pool);
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length > 0) process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import {
  buildDataCoverageMatrix,
  writeCoverageMatrixCache,
} from './dataCoverageMatrix.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const matrix = await buildDataCoverageMatrix(pool, config.MINUTE_DATA_ROOT);
    await writeCoverageMatrixCache(resolve('.cache/data-coverage.json'), matrix);
    console.log(JSON.stringify(matrix, null, 2));
    if (matrix.status === 'fail') process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import mysql from 'mysql2/promise';
import type { EnvConfig } from '../config.js';

export function createPool(config: EnvConfig) {
  return mysql.createPool({
    host: config.DB_HOST,
    port: parseInt(config.DB_PORT, 10),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    idleTimeout: 60000,
    enableKeepAlive: true,
  });
}

export async function checkConnection(
  pool: mysql.Pool,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function closePool(pool: mysql.Pool): Promise<void> {
  await pool.end();
}

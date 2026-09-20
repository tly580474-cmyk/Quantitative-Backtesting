import mysql from 'mysql2/promise';
import type { EnvConfig } from '../config.js';

export function createPool(config: EnvConfig) {
  return mysql.createPool({
    host: config.DB_HOST,
    port: parseInt(config.DB_PORT, 10),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    idleTimeout: 60000,
    enableKeepAlive: true,
  });
}

export async function checkConnection(
  pool: mysql.Pool,
): Promise<{ ok: boolean; error?: string }> {
  let connection: mysql.PoolConnection | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const conn = await pool.getConnection();
        if (expired) { conn.release(); return; }
        connection = conn;
        await conn.ping();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Database probe timed out')); }, 3_000);
      }),
    ]);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
    if (expired) connection?.destroy();
    else connection?.release();
  }
}

export async function closePool(pool: mysql.Pool): Promise<void> {
  await pool.end();
}

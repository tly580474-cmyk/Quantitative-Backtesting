import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type mysql from 'mysql2/promise';
import * as schema from './schema.js';

export { schema };

let dbInstance: MySql2Database<typeof schema> | null = null;

export function initDb(pool: mysql.Pool): MySql2Database<typeof schema> {
  if (!dbInstance) {
    dbInstance = drizzle(pool, { schema, mode: 'default' });
  }
  return dbInstance;
}

export function getDb(): MySql2Database<typeof schema> {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  dbInstance = null;
}

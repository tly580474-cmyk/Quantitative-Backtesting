import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(
  pool: mysql.Pool,
): Promise<{ applied: string[]; errors: string[] }> {
  const applied: string[] = [];
  const errors: string[] = [];

  // Ensure migrations tracking table exists
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at VARCHAR(24) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (err) {
    errors.push(`Failed to create _migrations table: ${String(err)}`);
    return { applied, errors };
  }

  // Find migration files
  const migrationsDir = join(__dirname, 'migrations');
  let files: string[] = [];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    errors.push(`Migrations directory not found: ${migrationsDir}`);
    return { applied, errors };
  }

  for (const file of files) {
    // Check if already applied
    const [rows] = await pool.execute(
      'SELECT name FROM _migrations WHERE name = ?',
      [file],
    ) as [unknown[], unknown];
    if (Array.isArray(rows) && rows.length > 0) continue;

    // Apply migration
    try {
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      const statements = sql
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        await pool.execute(stmt);
      }

      await pool.execute(
        'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
        [file, new Date().toISOString()],
      );
      applied.push(file);
      console.log(`[DB] Migration applied: ${file}`);
    } catch (err) {
      const msg = `Migration ${file} failed: ${String(err)}`;
      errors.push(msg);
      console.error(`[DB] ${msg}`);
    }
  }

  return { applied, errors };
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPool, closePool } from './pool.js';

/**
 * Applies schema.sql. Idempotent: every statement is CREATE ... IF NOT
 * EXISTS or CREATE OR REPLACE, so re-running is safe.
 */
async function migrate() {
  const pool = getPool();
  const sql = await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[migrate] schema applied');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] failed:', err.message);
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch(() => process.exit(1));
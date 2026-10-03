import pg from 'pg';

/**
 * Postgres pool. Kept behind this module so the route layer can be
 * tested against an in-memory repository without a live database.
 */
let pool = null;

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  pool = new pg.Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
  });

  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Wrap a row's geography into the shape the API returns. */
export function rowToPoi(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    accessibility: row.accessibility ?? [],
    safety: row.safety,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    source: row.source,
    verifiedAt: row.verified_at,
  };
}

/**
 * Wrap a sessions row into the shape the rest of the app expects.
 *
 * Postgres hands back snake_case columns, but `resolveUser` reads
 * `session.userId` and `session.expiresAt` -- the camelCase names memoryRepo
 * produces. Returning the raw row makes both undefined, which fails in two
 * silent ways: the user lookup gets `undefined` and every login 401s, and
 * `new Date(undefined)` is NaN, so the expiry check never fires and sessions
 * would never actually time out.
 */
export function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
  };
}
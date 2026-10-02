import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPool, closePool } from './pool.js';

/**
 * Seeds PostGIS from the frontend's canonical geojson.
 *
 * Upserts on lower(name) so re-running is safe. Run `npm run migrate`
 * first — this assumes the tables exist.
 */
async function seed() {
  const pool = getPool();

  const geojsonPath = resolve(
    import.meta.dirname,
    '../../../frontend/public/data/unimap.geojson',
  );
  const geojson = JSON.parse(await readFile(geojsonPath, 'utf8'));

  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;

  try {
    await client.query('BEGIN');

    for (const feature of geojson.features ?? []) {
      const props = feature.properties ?? {};
      const [lng, lat] = feature.geometry?.coordinates ?? [];
      if (!props.Name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const category = String(props.category ?? 'other').trim().toLowerCase().replace(/\s+/g, '-');

      const { rowCount } = await client.query(
        `INSERT INTO pois (name, category, description, accessibility, safety, location, source, verified_at)
         VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, 'seed', now())
         ON CONFLICT (lower(name)) DO UPDATE
           SET category = EXCLUDED.category,
               description = EXCLUDED.description,
               accessibility = EXCLUDED.accessibility,
               safety = EXCLUDED.safety,
               location = EXCLUDED.location
         RETURNING (xmax = 0) AS was_insert`,
        [
          props.Name.trim(),
          category,
          props.indoorDescription ?? null,
          props.accessibility ?? [],
          props.safety === true,
          lng,
          lat,
        ],
      );

      if (rowCount === 0) updated++;
      else inserted++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] failed:', err.message);
    throw err;
  } finally {
    client.release();
    await closePool();
  }

  console.log(`[seed] ${inserted} inserted, ${updated} skipped`);
}

seed().catch(() => process.exit(1));
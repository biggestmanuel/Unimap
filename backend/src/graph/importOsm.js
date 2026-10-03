/**
 * Import the OSM walk network into graph_edges.
 *
 *   node src/graph/importOsm.js
 *
 * Re-runnable: it replaces the previous `source = 'osm'` set inside a single
 * transaction, so hand-tracing more footpaths in JOSM and re-running this is
 * the whole update workflow.
 */

import { realpathSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getPool, closePool } from '../db/pool.js';
import { lineLengthMeters } from './geo.js';
import {
  CAMPUS_BBOX,
  analyseConnectivity,
  fetchOverpass,
  parseOverpass,
} from './overpass.js';

function fmt(n) {
  return n.toFixed(2);
}

/**
 * Replace the OSM edge set with `edges`.
 *
 * Takes parsed edges rather than an Overpass response so it works for both a
 * live fetch and a saved extract.
 */
export async function importEdges({ pool, edges }) {
  if (edges.length === 0) {
    throw new Error('No usable ways found -- refusing to wipe the graph.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Only wipe what we own. A hand-drawn edge traced in JOSM and saved with
    // a different source would survive, which is the intent.
    await client.query(`DELETE FROM graph_edges WHERE source = 'osm'`);

    // One multi-row insert rather than 300 round trips. Columns must line up
    // with params exactly: osm_id, name, geom, edge_class, surface, source.
    const values = [];
    const params = [];
    let i = 1;
    for (const e of edges) {
      // GeoJSON is [lng, lat]; PostGIS wants the same.
      const geojson = JSON.stringify({
        type: 'LineString',
        coordinates: e.coords.map((p) => [p.lng, p.lat]),
      });
      values.push(
        `($${i++}, $${i++}, ST_GeomFromGeoJSON($${i++}), $${i++}, $${i++}, $${i++})`,
      );
      params.push(
        e.osmId,
        edgeName(e.name),
        geojson,
        e.edgeClass,
        e.surface,
        'osm',
      );
    }

    await client.query(
      `INSERT INTO graph_edges (osm_id, name, geom, edge_class, surface, source)
       VALUES ${values.join(', ')}`,
      params,
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { edges };
}

/** Empty-string names would defeat the "group legs by name" leg builder. */
function edgeName(name) {
  return name && name.trim() ? name.trim() : null;
}

/**
 * Write the graph next to the POI data as plain JSON.
 *
 * This is what lets `npm run dev` route without Postgres: the API loads this
 * file when DATABASE_URL is unset. It is also the artefact the offline PWA
 * serves, so it has to exist independently of the database.
 *
 * Refuses to overwrite an existing graph with an empty one. A transient
 * Overpass hiccup must not be able to delete a working walk graph.
 */
export function writeGraphJson(edges, dest) {
  if (edges.length === 0) {
    let existing = 0;
    try {
      existing = JSON.parse(readFileSync(dest, 'utf-8')).length ?? 0;
    } catch {
      existing = 0;
    }
    if (existing > 0) {
      throw new Error(
        `Refusing to overwrite ${dest} (${existing} existing edges) with an empty graph.`,
      );
    }
  }

  const rows = edges.map((e) => ({
    osmId: e.osmId,
    name: edgeName(e.name),
    edgeClass: e.edgeClass,
    surface: e.surface,
    coords: e.coords,
  }));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(rows), 'utf-8');
  return dest;
}

/** Default location: served as a static asset by the frontend. */
export const GRAPH_JSON_PATH = fileURLToPath(
  new URL('../../../frontend/public/data/walk-graph.json', import.meta.url),
);

// ── CLI ────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // `--from=<path>` loads a saved extract instead of querying Overpass.
  // Overpass mirrors are community-run and rate-limit aggressively, so this
  // is often the only way to re-import without waiting.
  const fromArg = process.argv.find((a) => a.startsWith('--from='));
  const fromPath = fromArg ? fromArg.slice('--from='.length) : null;

  let edges;
  let skipped = null;

  if (fromPath) {
    const raw = JSON.parse(readFileSync(fromPath, 'utf-8'));
    edges = raw.map((r) => {
      const coords = r.coords.map((c) => (Array.isArray(c)
        ? { lat: c[1], lng: c[0] }        // [lng, lat] form
        : { lat: c.lat, lng: c.lng }));   // {lat,lng} form
      return {
        osmId: r.osmId ?? null,
        name: r.name ?? null,
        edgeClass: r.edgeClass,
        surface: r.surface ?? null,
        coords,
        lengthMeters: lineLengthMeters(coords),
      };
    });
    console.log(`loaded ${edges.length} edges from ${fromPath}`);
  } else {
    const json = await fetchOverpass(CAMPUS_BBOX);
    ({ edges, skipped } = parseOverpass(json, { bbox: CAMPUS_BBOX }));
  }

  const stats = analyseConnectivity(edges);

  if (!fromPath) {
    const dest = writeGraphJson(edges, GRAPH_JSON_PATH);
    console.log(`wrote ${edges.length} edges -> ${dest}`);
  }

  if (process.env.DATABASE_URL) {
    // Pass the already-parsed edges rather than the raw response, so the
    // --from path works too.
    await importEdges({ pool: getPool(), edges });
    console.log('imported into graph_edges');
    await closePool();
  } else {
    console.log('DATABASE_URL not set — skipped the PostGIS import');
  }

  if (skipped) console.log(`  skipped: ${JSON.stringify(skipped)}`);
  for (const c of stats.byClass) {
    console.log(
      `  ${c.edgeClass.padEnd(9)} ${String(c.ways).padStart(4)} ways  `
      + `${fmt(c.meters / 1000).padStart(7)} km  `
      + `${fmt((100 * c.routableMeters) / (c.meters || 1)).padStart(5)}% routable`,
    );
  }
  console.log(`  connected groups: ${stats.groups} (largest ${stats.mainWays} ways)`);
  console.log(`  routable: ${fmt(stats.routableMeters / 1000)} km of ${fmt(stats.totalMeters / 1000)} km`);
  console.log(`  dead-end nodes: ${stats.deadEndCount}`);
  if (stats.islands.length > 0) {
    console.log(`  islands: ${stats.islands.length}`);
    for (const isl of stats.islands.slice(0, 10)) {
      console.log(`    ${String(isl.ways).padStart(3)} ways ${fmt(isl.meters).padStart(7)} m `
        + `${isl.edgeClasses.join('/')}${isl.names.length ? `  ${isl.names.join(', ')}` : ''}`);
    }
    if (stats.islands.length > 10) console.log(`    ...and ${stats.islands.length - 10} more`);
  }
}
/**
 * Import the OSM walk network into graph_edges.
 *
 *   node src/graph/importOsm.js
 *
 * Re-runnable: it replaces the previous `source = 'osm'` set inside a single
 * transaction, so hand-tracing more footpaths in JOSM and re-running this is
 * the whole update workflow.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../db/pool.js';
import {
  CAMPUS_BBOX,
  analyseConnectivity,
  fetchOverpass,
  parseOverpass,
} from './overpass.js';

function fmt(n) {
  return n.toFixed(2);
}

export async function importGraph({ pool, bbox = CAMPUS_BBOX, json = null } = {}) {
  const data = json ?? await fetchOverpass(bbox);
  const { edges, skipped } = parseOverpass(data, { bbox });

  if (edges.length === 0) {
    throw new Error('No usable ways found -- refusing to wipe the graph.');
  }

  const stats = analyseConnectivity(edges);

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

  return { edges, skipped, stats };
}

/** Empty-string names would defeat the "group legs by name" leg builder. */
function edgeName(name) {
  return name && name.trim() ? name.trim() : null;
}

// ── CLI ────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const pool = getPool();
  const { edges, skipped, stats } = await importGraph({ pool });

  console.log(`imported ${edges.length} ways`);
  console.log(`  skipped: ${JSON.stringify(skipped)}`);
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

  await closePool();
}
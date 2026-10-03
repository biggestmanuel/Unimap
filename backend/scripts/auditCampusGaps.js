/**
 * Diagnose the campus data gaps that would otherwise need a human with
 * satellite imagery.
 *
 *   node scripts/auditCampusGaps.js
 *
 * Answers, per problematic POI: is the coordinate wrong, or is the *path*
 * missing? Those need opposite fixes -- move the POI, or trace a way -- and
 * guessing wrong makes things worse. The test is whether OSM has a building
 * footprint at the POI: if it does, the coordinate is probably about right
 * and a walkway is what is absent.
 *
 * Then reports the gap between each graph island and the main network, so an
 * island can be closed with one specific piece of geometry instead of
 * guesswork.
 */

import { readFileSync } from 'node:fs';
import {
  CAMPUS_BBOX,
  fetchOverpass,
  parseOverpass,
  analyseConnectivity,
} from '../src/graph/overpass.js';
import { buildGraph, snapToGraph } from '../src/graph/router.js';
import { haversineMeters } from '../src/graph/geo.js';

/** POIs further than this from a routable way get investigated. */
const POI_SUSPECT_METERS = 30;

/** A building vertex within this distance suggests the coordinate is fine. */
const BUILDING_HINT_METERS = 45;

/** Islands smaller than this are driveways and not worth closing. */
const ISLAND_MIN_METERS = 150;

const nodeKey = (p) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;

function readPois() {
  const geo = JSON.parse(readFileSync(
    new URL('../../frontend/public/data/unimap.geojson', import.meta.url),
    'utf-8',
  ));
  return geo.features
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => ({
      name: f.properties.Name,
      point: { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] },
    }));
}

/** Union-find over way vertices, so connectivity is decided by shared points. */
function componentOf(edges) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const e of edges) {
    for (const c of e.coords) if (!parent.has(nodeKey(c))) parent.set(nodeKey(c), nodeKey(c));
  }
  for (const e of edges) {
    for (let i = 1; i < e.coords.length; i += 1) {
      union(nodeKey(e.coords[i - 1]), nodeKey(e.coords[i]));
    }
  }
  return (edge) => find(nodeKey(edge.coords[0]));
}

async function fetchBuildings() {
  const b = `${CAMPUS_BBOX.minLat},${CAMPUS_BBOX.minLng},${CAMPUS_BBOX.maxLat},${CAMPUS_BBOX.maxLng}`;
  const q = `[out:json][timeout:180];way["building"](${b});out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'unimap-audit/0.2' },
    body: `data=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Overpass responded ${res.status}`);

  const vertices = [];
  for (const el of (await res.json()).elements ?? []) {
    for (const pt of el.geometry ?? []) {
      vertices.push({ lat: pt.lat, lng: pt.lon });
    }
  }
  return vertices;
}

async function run() {
  const pois = readPois();

  console.log(`fetching the OSM walk network for ${pois.length} POIs...`);
  const { edges, skipped } = parseOverpass(await fetchOverpass(CAMPUS_BBOX), {
    bbox: CAMPUS_BBOX,
  });
  const stats = analyseConnectivity(edges);
  const graph = buildGraph(edges);
  const componentOfEdge = componentOf(edges);

  const counts = new Map();
  for (const e of edges) {
    const r = componentOfEdge(e);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const mainRoot = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const mainEdges = edges.filter((e) => componentOfEdge(e) === mainRoot);

  console.log(`  ${edges.length} ways, ${stats.groups} components, main = ${mainEdges.length} ways`);
  console.log(`  skipped: ${JSON.stringify(skipped)}\n`);

  // ── POIs off the network ─────────────────────────────────────────────
  console.log('='.repeat(74));
  console.log(`POIs further than ${POI_SUSPECT_METERS} m from any routable way`);
  console.log('='.repeat(74));

  const suspects = pois
    .map((p) => {
      const snap = snapToGraph(p.point, graph, { maxDistanceMeters: 120 });
      return { ...p, distance: snap ? snap.distanceMeters : Infinity };
    })
    .filter((p) => p.distance > POI_SUSPECT_METERS)
    .sort((a, b) => b.distance - a.distance);

  if (suspects.length === 0) {
    console.log('  none — every POI is within reach of the network\n');
  } else {
    let buildings = [];
    try {
      buildings = await fetchBuildings();
      console.log(`  ${suspects.length} to investigate; `
        + `${buildings.length} building vertices fetched as evidence.\n`);
    } catch (err) {
      console.log(`  ${suspects.length} to investigate `
        + `(buildings unavailable: ${err.message}).\n`);
    }

    console.log(`  ${'POI'.padEnd(32)} ${'off path'.padStart(8)}  `
      + `${'building'.padEnd(10)} what to do`);
    console.log(`  ${'-'.repeat(74)}`);

    for (const s of suspects) {
      let nearestBuilding = Infinity;
      for (const b of buildings) {
        const d = haversineMeters(s.point, b);
        if (d < nearestBuilding) nearestBuilding = d;
      }
      const hasBuilding = nearestBuilding <= BUILDING_HINT_METERS;

      // The verdict is the part that saves someone opening JOSM.
      const verdict = hasBuilding
        ? 'coordinate looks right — trace a path to it'
        : 'NO BUILDING here — check the coordinate';

      // Node's console.log has no printf-style width specifiers, so pad
    // explicitly rather than passing an array to `%`.
    const nameCell = s.name.slice(0, 32).padEnd(32);
    const distCell = `${Math.round(s.distance)} m`.padStart(7);
    const buildingCell = (hasBuilding ? `${Math.round(nearestBuilding)} m` : 'none').padEnd(10);
    console.log(`  ${nameCell} ${distCell}  ${buildingCell} ${verdict}`);
    }
    console.log('');
  }

  // ── island gaps ─────────────────────────────────────────────────────
  console.log('='.repeat(74));
  console.log('ISLANDS — the specific gap that would close each one');
  console.log('='.repeat(74));

  const mainVertices = [];
  for (const e of mainEdges) for (const c of e.coords) mainVertices.push(c);

  const islands = stats.islands
    .filter((i) => i.meters >= ISLAND_MIN_METERS)
    .sort((a, b) => b.meters - a.meters);

  if (islands.length === 0) {
    console.log(`  none at or above ${ISLAND_MIN_METERS} m\n`);
  }

  for (const isl of islands) {
    const vertices = [];
    for (const e of edges) {
      if (isl.osmIds.includes(e.osmId)) vertices.push(...e.coords);
    }

    let best = Infinity;
    let fromPt = null;
    let toPt = null;
    for (const a of vertices) {
      for (const b of mainVertices) {
        const d = haversineMeters(a, b);
        if (d < best) {
          best = d;
          fromPt = a;
          toPt = b;
        }
      }
    }

    console.log(
      `  ${String(isl.ways).padStart(2)} ways, ${Math.round(isl.meters)} m `
      + `${isl.names.length ? `(${isl.names.join(', ')})` : '(unnamed)'}`,
    );
    console.log(`      class: ${isl.edgeClasses.join(', ')}`);
    console.log(`      closest approach to the main network: ${Math.round(best)} m`);
    if (fromPt && toPt && best > 0) {
      console.log(`      link from ${fromPt.lat.toFixed(6)},${fromPt.lng.toFixed(6)}`);
      console.log(`           to ${toPt.lat.toFixed(6)},${toPt.lng.toFixed(6)}`);
      console.log('      -> add a way between those two points, sharing both vertices');
    }
    console.log('');
  }

  console.log('Summary:');
  console.log(`  POIs needing attention : ${suspects.length}`);
  console.log(`  islands worth closing  : ${islands.length}`);
  console.log(`  ways skipped as out of bbox: ${skipped.outOfBounds}`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
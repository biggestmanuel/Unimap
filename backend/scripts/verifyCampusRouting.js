/**
 * End-to-end check of the walk graph against live OSM data for RSU.
 * Needs network, so it is a script rather than a test.
 *
 *   node scripts/verifyCampusRouting.js
 */
import { readFileSync } from 'node:fs';
import {
  CAMPUS_BBOX,
  analyseConnectivity,
  fetchOverpass,
  parseOverpass,
} from '../src/graph/overpass.js';
import { buildGraph, findRoute } from '../src/graph/router.js';
import { haversineMeters } from '../src/graph/geo.js';

const geo = JSON.parse(readFileSync(
  new URL('../../frontend/public/data/unimap.geojson', import.meta.url),
  'utf-8',
));

const named = new Map();
for (const f of geo.features) {
  if (f.geometry.type === 'Point') {
    named.set(f.properties.Name, {
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
    });
  }
}

console.log('fetching OSM ways for the campus bbox...');
const json = await fetchOverpass(CAMPUS_BBOX);
const { edges, skipped } = parseOverpass(json, { bbox: CAMPUS_BBOX });
const stats = analyseConnectivity(edges);

console.log(`\nparsed ${edges.length} ways  (skipped ${JSON.stringify(skipped)})`);
for (const c of stats.byClass) {
  console.log(
    `  ${c.edgeClass.padEnd(9)} ${String(c.ways).padStart(4)} ways  `
    + `${(c.meters / 1000).toFixed(2).padStart(7)} km  `
    + `${((100 * c.routableMeters) / (c.meters || 1)).toFixed(0).padStart(4)}% routable`,
  );
}
console.log(`  connected groups: ${stats.groups} (largest ${stats.mainWays} ways)`);
console.log(`  dead-end nodes:   ${stats.deadEndCount}`);
console.log(`  islands: ${stats.islands.length} (largest ${stats.islands[0]?.ways ?? 0} ways)`);

const graph = buildGraph(edges);
console.log(`\ngraph: ${graph.segments.length} segments, ${graph.adj.size} nodes`);

const PAIRS = [
  ['NEH', 'Maracana Field'],
  ['FACULTY OF ENGINEERING', 'NDDC Hostel'],
  ['Amphitheatre', 'Microfinance Bank'],
  ['UST Shuttle Park', 'Faculty of Law, Rivers State University'],
  ['NEH', 'Convo Arena Field'],
];

console.log('\n--- real routes ---');
let failed = 0;
for (const [fromName, toName] of PAIRS) {
  const from = named.get(fromName);
  const to = named.get(toName);
  if (!from || !to) {
    console.log(`  SKIP ${fromName} -> ${toName} (not a seeded POI)`);
    continue;
  }
  const route = findRoute(graph, from, to);
  const crow = haversineMeters(from, to);
  if (!route.found) {
    failed += 1;
    console.log(`  ${fromName} -> ${toName}`);
    console.log(`    FALLBACK (${route.reason})  straight line ${Math.round(crow)} m`);
    continue;
  }
  console.log(`  ${fromName} -> ${toName}`);
  console.log(`    ${Math.round(route.distanceMeters)} m  `
    + `${Math.round(route.durationSeconds / 60)} min  `
    + `(crow ${Math.round(crow)} m, detour ${route.distanceMeters / crow}x)`);
  console.log(`    snap: ${Math.round(route.snappedOriginMeters)} m in, `
    + `${Math.round(route.snappedDestinationMeters)} m out`);
  for (const leg of route.legs) {
    console.log(`      - ${leg.name ?? '(unnamed)'} [${leg.edgeClass}] `
      + `${Math.round(leg.lengthMeters)} m`);
  }
}

console.log(`\n${PAIRS.length - failed}/${PAIRS.length} pairs routed on the graph`);
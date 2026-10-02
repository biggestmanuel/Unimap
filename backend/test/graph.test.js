/**
 * Walk-graph tests.
 *
 * The router and the Overpass parser are pure, so these run with no database
 * and no network. The fixtures are hand-built miniature networks rather than
 * real campus data, because the interesting cases are the degenerate ones:
 * disconnected islands, a POI off the network, a footpath leading nowhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineMeters,
  lineLengthMeters,
  nodeKey,
  pointInPolygon,
  projectToSegment,
  withinBbox,
} from '../src/graph/geo.js';
import { buildGraph, findRoute, snapToGraph } from '../src/graph/router.js';
import {
  analyseConnectivity,
  classifyWay,
  overpassQuery,
  parseOverpass,
  CAMPUS_BBOX,
} from '../src/graph/overpass.js';

const CAMPUS = { minLat: 4.79, maxLat: 4.81, minLng: 6.97, maxLng: 6.99 };

/** A point `northMeters`/`eastMeters` from an origin. */
function offset(origin, northMeters, eastMeters) {
  const dLat = northMeters / 111320;
  const dLng = eastMeters / (111320 * Math.cos(origin.lat * Math.PI / 180));
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

// ── geo ────────────────────────────────────────────────────────────────
test('haversine matches a known distance', () => {
  // One degree of latitude is ~111.19 km anywhere on the globe.
  const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111195) < 50, `got ${d}`);
});

test('haversine is symmetric and zero for a point against itself', () => {
  const a = { lat: 4.797, lng: 6.982 };
  assert.equal(haversineMeters(a, a), 0);
  assert.equal(
    haversineMeters(a, { lat: 4.8, lng: 6.99 }),
    haversineMeters({ lat: 4.8, lng: 6.99 }, a),
  );
});

test('projectToSegment puts a point on its nearest spot on the line', () => {
  const a = { lat: 4.79, lng: 6.98 };
  const b = { lat: 4.80, lng: 6.98 };      // due north
  const p = offset({ lat: 4.795, lng: 6.9805 }, 0, 0); // ~55 m east

  const r = projectToSegment(p, a, b);
  assert.ok(r.distanceMeters > 50 && r.distanceMeters < 60, `got ${r.distanceMeters}`);
  assert.ok(Math.abs(r.point.lat - 4.795) < 0.0001, 'projection should be level with p');
  assert.ok(Math.abs(r.point.lng - 6.98) < 1e-9, 'projection should sit on the segment');
});

test('projectToSegment clamps past the end of a segment', () => {
  const a = { lat: 4.79, lng: 6.98 };
  const b = { lat: 4.80, lng: 6.98 };
  const p = { lat: 4.81, lng: 6.98 };       // beyond b

  const r = projectToSegment(p, a, b);
  assert.equal(r.t, 1);
  assert.ok(Math.abs(r.distanceMeters - haversineMeters(p, b)) < 0.5);
});

test('lineLengthMeters sums a polyline', () => {
  const a = { lat: 4.79, lng: 6.98 };
  const b = { lat: 4.80, lng: 6.98 };
  const c = { lat: 4.80, lng: 6.99 };
  const total = lineLengthMeters([a, b, c]);
  assert.ok(Math.abs(total - (haversineMeters(a, b) + haversineMeters(b, c))) < 0.01);
});

test('pointInPolygon distinguishes inside from outside', () => {
  const ring = [
    { lat: 4.79, lng: 6.97 },
    { lat: 4.81, lng: 6.97 },
    { lat: 4.81, lng: 6.99 },
    { lat: 4.79, lng: 6.99 },
  ];
  assert.equal(pointInPolygon({ lat: 4.80, lng: 6.98 }, ring), true);
  assert.equal(pointInPolygon({ lat: 4.85, lng: 6.98 }, ring), false);
  assert.equal(pointInPolygon({ lat: 4.80, lng: 7.05 }, ring), false);
});

test('nodeKey merges coincident points but not distinct ones', () => {
  assert.equal(nodeKey({ lat: 4.7970000, lng: 6.9820000 }), nodeKey({ lat: 4.797, lng: 6.982 }));
  assert.notEqual(nodeKey({ lat: 4.797, lng: 6.982 }), nodeKey({ lat: 4.79701, lng: 6.982 }));
});

// ── graph construction ─────────────────────────────────────────────────
const ORIGIN = { lat: 4.79, lng: 6.98 };

/**
 * Two corridors meeting at a genuine shared node.
 *
 * Road A carries an explicit middle vertex at the junction. That matters:
 * connectivity here is decided by shared *nodes*, not by the two ways
 * crossing on the map. See the test below that pins this behaviour down.
 */
function crossroads() {
  const junction = offset(ORIGIN, 200, 0);
  return buildGraph([
    {
      coords: [ORIGIN, junction, offset(ORIGIN, 400, 0)],
      edgeClass: 'corridor',
      name: 'Road A',
    },
    { coords: [junction, offset(ORIGIN, 200, 300)], edgeClass: 'corridor', name: 'Road B' },
  ]);
}

test('buildGraph joins ways that share a node', () => {
  const g = crossroads();
  assert.ok(g.adj.has(nodeKey(ORIGIN)), 'origin should be a node');
  assert.ok(g.adj.has(nodeKey(offset(ORIGIN, 200, 0))), 'shared junction should be a node');
  assert.equal(g.segments.length, 3, 'Road A splits into 2 segments, Road B is 1');
});

test('ways that cross without sharing a node are NOT connected', () => {
  // The single most common way a hand-traced graph goes wrong: two ways that
  // visibly meet on the map but whose endpoints are different OSM nodes, so
  // the router sees two dead ends and no route. Fixing it means adding a
  // shared node at the junction in JOSM.
  const g = buildGraph([
    { coords: [ORIGIN, offset(ORIGIN, 400, 0)], edgeClass: 'corridor', name: 'Road A' },
    { coords: [offset(ORIGIN, 200, 0), offset(ORIGIN, 200, 300)], edgeClass: 'corridor', name: 'Road B' },
  ]);

  const stats = analyseConnectivity([
    { osmId: 1, edgeClass: 'corridor', lengthMeters: 400, coords: [ORIGIN, offset(ORIGIN, 400, 0)] },
    { osmId: 2, edgeClass: 'corridor', lengthMeters: 300, coords: [offset(ORIGIN, 200, 0), offset(ORIGIN, 200, 300)] },
  ]);
  assert.equal(stats.groups, 2, 'the two ways are separate components');

  const route = findRoute(g, offset(ORIGIN, 380, 0), offset(ORIGIN, 200, 290));
  assert.equal(route.found, false, 'no route without a shared node');
  assert.equal(route.reason, 'network_disconnected');
});

test('snapToGraph finds the nearest way and reports the distance', () => {
  const g = crossroads();
  // 25 m east of the spine and well clear of the branch, which runs east at
  // 200 m north.
  const p = offset(ORIGIN, 350, 25);
  const snap = snapToGraph(p, g);
  assert.ok(snap, 'should snap');
  assert.ok(snap.distanceMeters > 20 && snap.distanceMeters < 30, `got ${snap.distanceMeters}`);
});

test('snapToGraph returns null when everything is beyond the limit', () => {
  const g = crossroads();
  const far = { lat: 4.70, lng: 6.90 };
  assert.equal(snapToGraph(far, g, { maxDistanceMeters: 10 }), null);
});

// ── routing ────────────────────────────────────────────────────────────
test('finds a route along connected ways', () => {
  const g = crossroads();
  const route = findRoute(g, offset(ORIGIN, 10, 0), offset(ORIGIN, 390, 0));

  assert.equal(route.found, true);
  assert.equal(route.mode, 'graph');
  // ~380 m of spine, plus the two short hops on and off the network.
  assert.ok(route.distanceMeters > 370 && route.distanceMeters < 420, `got ${route.distanceMeters}`);
  assert.ok(route.coords.length >= 2);
  assert.ok(route.durationSeconds > 0);
});

test('route distance is never shorter than the straight line', () => {
  const g = crossroads();
  const from = offset(ORIGIN, 10, 0);
  const to = offset(ORIGIN, 390, 0);
  const route = findRoute(g, from, to);
  assert.ok(
    route.distanceMeters >= haversineMeters(from, to) - 1,
    'a walked route cannot beat the crow flight',
  );
});

test('routes through the junction between two corridors', () => {
  const g = crossroads();
  const route = findRoute(g, offset(ORIGIN, 380, 0), offset(ORIGIN, 200, 290));
  assert.equal(route.found, true);
  assert.ok(route.distanceMeters > 300, `got ${route.distanceMeters}`);
  // Walking down Road A then along Road B should be two named legs.
  const names = new Set(route.legs.map((l) => l.name));
  assert.deepEqual([...names].sort(), ['Road A', 'Road B']);
});

test('falls back to a straight line when the destination is off-network', () => {
  const g = crossroads();
  const route = findRoute(g, offset(ORIGIN, 10, 0), { lat: 4.85, lng: 6.90 });

  assert.equal(route.found, false);
  assert.equal(route.mode, 'straight_line');
  assert.equal(route.reason, 'destination_off_network');
  assert.ok(route.distanceMeters > 0);
  assert.equal(route.coords.length, 2);
});

test('falls back to a straight line across a disconnected network', () => {
  // Two ways that never meet: the origin snaps to one, the destination to
  // the other, and there is no path between the two components.
  const g = buildGraph([
    { coords: [ORIGIN, offset(ORIGIN, 100, 0)], edgeClass: 'corridor', name: 'North way' },
    { coords: [offset(ORIGIN, 400, 0), offset(ORIGIN, 500, 0)], edgeClass: 'corridor', name: 'South way' },
  ]);
  const route = findRoute(g, offset(ORIGIN, 10, 0), offset(ORIGIN, 490, 0));
  assert.equal(route.found, false);
  assert.equal(route.reason, 'network_disconnected');
});

test('two points on the same way route along it', () => {
  const g = crossroads();
  // Both snaps land on Road A's single segment -- there is no node between
  // them, so this must not report a zero distance.
  const route = findRoute(g, offset(ORIGIN, 50, 0), offset(ORIGIN, 350, 0));
  assert.equal(route.found, true);
  assert.equal(route.mode, 'graph');
  assert.ok(Math.abs(route.distanceMeters - 300) < 5, `got ${route.distanceMeters}`);
  assert.ok(route.legs.length >= 1, 'should still report a leg');
});

test('an empty graph still yields a usable straight line', () => {
  const g = buildGraph([]);
  const route = findRoute(g, ORIGIN, offset(ORIGIN, 500, 0));
  assert.equal(route.mode, 'straight_line');
  assert.equal(route.reason, 'origin_off_network');
});

test('ignores degenerate edges', () => {
  const g = buildGraph([
    { coords: [ORIGIN, ORIGIN], edgeClass: 'corridor' },              // zero length
    { coords: [ORIGIN], edgeClass: 'corridor' },                     // single point
    { coords: [ORIGIN, offset(ORIGIN, 100, 0)], edgeClass: 'corridor' }, // the real one
  ]);
  assert.equal(g.edgeCount, 3);
  assert.equal(g.segments.length, 1, 'only the usable edge becomes a segment');
});

test('a footpath shortcut is preferred over the long way round', () => {
  // A square loop with a diagonal footpath across it.
  const nw = offset(ORIGIN, 300, 0);
  const ne = offset(ORIGIN, 300, 300);
  const sw = offset(ORIGIN, 0, 0);
  const se = offset(ORIGIN, 0, 300);
  const g = buildGraph([
    { coords: [sw, nw], edgeClass: 'corridor', name: 'West' },
    { coords: [nw, ne], edgeClass: 'corridor', name: 'North' },
    { coords: [ne, se], edgeClass: 'corridor', name: 'East' },
    { coords: [sw, se], edgeClass: 'corridor', name: 'South' },
    { coords: [sw, ne], edgeClass: 'footpath', name: 'Diagonal path' },
  ]);

  const route = findRoute(g, offset(ORIGIN, 10, 10), offset(ORIGIN, 290, 290));
  assert.equal(route.found, true);
  const usedPath = route.legs.some((l) => l.edgeClass === 'footpath');
  assert.ok(usedPath, 'the diagonal footpath should be chosen over 600 m of corridor');
  assert.ok(route.distanceMeters < 500, `got ${route.distanceMeters}`);
});

test('a footpath that connects to nothing is never routed through', () => {
  const deadEnd = offset(ORIGIN, 500, 800);
  const g = buildGraph([
    { coords: [ORIGIN, offset(ORIGIN, 300, 0)], edgeClass: 'corridor', name: 'Road A' },
    // Dangling footpath, shares no node with anything.
    { coords: [deadEnd, offset(deadEnd, 200, 0)], edgeClass: 'footpath', name: 'Nowhere' },
  ]);

  const route = findRoute(g, offset(ORIGIN, 10, 0), offset(ORIGIN, 290, 0));
  assert.equal(route.found, true);
  assert.ok(!route.legs.some((l) => l.edgeClass === 'footpath'), 'dead footpath must be ignored');
});

// ── Overpass parsing ───────────────────────────────────────────────────
test('classifyWay separates pedestrian tags from roads', () => {
  assert.equal(classifyWay({ highway: 'footway' }), 'footpath');
  assert.equal(classifyWay({ highway: 'steps' }), 'footpath');
  assert.equal(classifyWay({ highway: 'residential' }), 'corridor');
  assert.equal(classifyWay({ highway: 'service' }), 'corridor');
});

test('classifyWay rejects untagged, private and under-construction ways', () => {
  assert.equal(classifyWay({}), null);
  assert.equal(classifyWay({ highway: 'footway', access: 'private' }), null);
  assert.equal(classifyWay({ highway: 'footway', foot: 'no' }), null);
  assert.equal(classifyWay({ highway: 'construction' }), null);
});

test('overpassQuery covers the campus bbox', () => {
  const q = overpassQuery(CAMPUS_BBOX);
  assert.match(q, /4\.788,6\.972,4\.808,6\.99/);
  assert.match(q, /way\["highway"\]/);
});

test('parseOverpass converts lng/lat and drops out-of-bbox ways', () => {
  const json = {
    elements: [
      { type: 'node', id: 1, lat: 4.7900, lon: 6.9800 },
      { type: 'node', id: 2, lat: 4.8000, lon: 6.9800 },
      { type: 'node', id: 3, lat: 4.8500, lon: 6.9800 }, // far outside
      { type: 'node', id: 4, lat: 4.9000, lon: 6.9000 }, // far outside
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'footway' } },
      { type: 'way', id: 101, nodes: [1, 3], tags: { highway: 'residential' } },
      { type: 'way', id: 102, nodes: [3, 4], tags: { highway: 'service' } },
    ],
  };

  const { edges, skipped } = parseOverpass(json, { bbox: CAMPUS });
  assert.equal(edges.length, 1, 'only the fully-inside way survives');
  assert.equal(edges[0].osmId, 100);
  assert.equal(edges[0].edgeClass, 'footpath');
  // GeoJSON order is [lng, lat]; make sure the swap did not happen.
  assert.deepEqual(
    { lat: edges[0].coords[0].lat, lng: edges[0].coords[0].lng },
    { lat: 4.79, lng: 6.98 },
  );
  assert.ok(skipped.outOfBounds >= 1);
});

test('parseOverpass survives a way referencing a missing node', () => {
  const json = {
    elements: [
      { type: 'node', id: 1, lat: 4.79, lon: 6.98 },
      { type: 'way', id: 1, nodes: [1, 999], tags: { highway: 'footway' } },
    ],
  };
  const { edges, skipped } = parseOverpass(json, { bbox: CAMPUS });
  assert.equal(edges.length, 0);
  assert.equal(skipped.offNetwork, 1);
});

test('parseOverpass handles an empty response', () => {
  const { edges, skipped } = parseOverpass({ elements: [] });
  assert.equal(edges.length, 0);
  assert.ok(skipped);
});

// ── connectivity analysis ──────────────────────────────────────────────
test('analyseConnectivity separates islands from the main network', () => {
  const edges = [
    { osmId: 1, edgeClass: 'corridor', lengthMeters: 100, coords: [ORIGIN, offset(ORIGIN, 100, 0)] },
    { osmId: 2, edgeClass: 'corridor', lengthMeters: 100, coords: [offset(ORIGIN, 100, 0), offset(ORIGIN, 200, 0)] },
    { osmId: 3, edgeClass: 'footpath', lengthMeters: 80, coords: [offset(ORIGIN, 900, 0), offset(ORIGIN, 980, 0)] },
  ];

  const stats = analyseConnectivity(edges);
  assert.equal(stats.totalWays, 3);
  assert.equal(stats.groups, 2);
  assert.equal(stats.mainWays, 2);
  assert.equal(stats.islands.length, 1);
  assert.equal(stats.islands[0].osmIds[0], 3);
  assert.deepEqual(stats.islands[0].edgeClasses, ['footpath']);
  assert.equal(Math.round(stats.routableMeters), 200);
});

test('analyseConnectivity counts a way that touches nothing as an island', () => {
  const edges = [
    { osmId: 1, edgeClass: 'corridor', lengthMeters: 100, coords: [ORIGIN, offset(ORIGIN, 100, 0)] },
  ];
  const stats = analyseConnectivity(edges);
  assert.equal(stats.mainWays, 1);
  assert.equal(stats.islands.length, 0);
  assert.equal(stats.deadEndCount, 2, 'both ends of a lone way are dead ends');
});
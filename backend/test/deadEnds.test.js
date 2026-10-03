/**
 * Phase 2: dead-end counting must agree with the router.
 *
 * The old implementation counted way *endpoints* and reported 344 dead ends on
 * 323 ways, which is not a meaningful number: any way meeting another partway
 * along looked like it ended at both ends.
 *
 * `deadEndCount` is only useful if it means the same thing as "a vertex the
 * router cannot walk out of", so these tests assert the two agree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyseConnectivity } from '../src/graph/overpass.js';
import { buildGraph } from '../src/graph/router.js';

/** Vertices with exactly one link, as the router sees them. */
function routerDeadEnds(edges) {
  const { adj } = buildGraph(edges);
  let n = 0;
  for (const [, links] of adj) if (links.length === 1) n += 1;
  return n;
}

test('a lone way has two dead ends', () => {
  const edges = [{
    edgeClass: 'corridor',
    name: 'Solo',
    coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }],
  }];
  assert.equal(analyseConnectivity(edges).deadEndCount, 2);
  assert.equal(routerDeadEnds(edges), 2, 'router must agree');
});

test('two ways meeting end to end have two dead ends, at the outer tips', () => {
  const edges = [
    { edgeClass: 'corridor', name: 'A', coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }] },
    { edgeClass: 'corridor', name: 'B', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.80, lng: 6.979 }] },
  ];
  // The shared vertex has degree 2 and is not a dead end; the two outer tips do
  // not connect to anything and are. This is what the old endpoint-counting
  // got right by accident and the new link-degree gets right by reasoning.
  assert.equal(analyseConnectivity(edges).deadEndCount, 2);
  assert.equal(routerDeadEnds(edges), 2, 'router must agree');
});

test('a closed loop has no dead ends', () => {
  const edges = [{
    edgeClass: 'corridor',
    name: 'Loop',
    coords: [
      { lat: 4.79, lng: 6.979 }, { lat: 4.79, lng: 6.984 },
      { lat: 4.80, lng: 6.984 }, { lat: 4.80, lng: 6.979 }, { lat: 4.79, lng: 6.979 },
    ],
  }];
  assert.equal(analyseConnectivity(edges).deadEndCount, 0);
  assert.equal(routerDeadEnds(edges), 0, 'router must agree');
});

// NOTE ON TEST FIXTURES
//
// These fixtures give every way its own explicit vertices, including shared
// junctions. That is how OSM data actually arrives -- OSM splits a road at
// every node where something else joins it -- and it is the only shape the
// router can connect.
//
// The router splits each way at its OWN vertices (`buildGraph` walks
// consecutive coordinate pairs). A branch that meets another way's interior at
// a point that is not a vertex of that way is therefore NOT connected, and
// both this metric and the router report it as a dead end. That is consistent,
// and correct for OSM input, but it does mean a junction must be present as a
// vertex on every way that passes through it.

test('a T junction has three dead ends, none of them the junction', () => {
  // Shared junction expressed the way OSM would: both ways carry the junction
  // as an explicit vertex.
  const edges = [
    { edgeClass: 'corridor', name: 'Through', coords: [
      { lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }, { lat: 4.80, lng: 6.979 },
    ] },
    { edgeClass: 'corridor', name: 'Branch', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.795, lng: 6.984 }] },
  ];
  // Three: the through-road's two outer tips plus the far end of the branch.
  // The shared junction has three links and is not one of them.
  //
  // The old implementation counted 4 here (every endpoint of every way),
  // because it never considered that a shared vertex is not a dead end.
  assert.equal(analyseConnectivity(edges).deadEndCount, 3);
  assert.equal(routerDeadEnds(edges), 3, 'router must agree');
});

test('a branch meeting another way mid-segment is not connected', () => {
  // Documented limitation, pinned so it cannot change silently: the router
  // splits ways at their own vertices, so a junction that exists only as an
  // interior coordinate of another way stays separate. Harmless for OSM data,
  // which always splits at shared nodes.
  const edges = [
    { edgeClass: 'corridor', name: 'Through', coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.80, lng: 6.979 }] },
    { edgeClass: 'corridor', name: 'Branch', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.795, lng: 6.984 }] },
  ];
  const stats = analyseConnectivity(edges);
  assert.equal(stats.groups, 2, 'the branch is its own component');
  assert.equal(stats.deadEndCount, 4, 'every tip counts, including the unmatched junction point');
  assert.equal(routerDeadEnds(edges), 4, 'router must agree');
});

test('an interior branch on a shared vertex adds no dead ends', () => {
  const edges = [
    { edgeClass: 'corridor', name: 'Through', coords: [
      { lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }, { lat: 4.80, lng: 6.979 },
    ] },
    { edgeClass: 'footpath', name: 'Side', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.795, lng: 6.982 }] },
  ];
  assert.equal(analyseConnectivity(edges).deadEndCount, 3);
  assert.equal(routerDeadEnds(edges), 3, 'router must agree');
});

test('dead ends never exceed the number of way endpoints', () => {
  // The old implementation violated this on real data, reporting more dead
  // ends than there were ways.
  const edges = [
    { edgeClass: 'corridor', name: 'A', coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }] },
    { edgeClass: 'corridor', name: 'B', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.80, lng: 6.979 }] },
    { edgeClass: 'corridor', name: 'C', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.795, lng: 6.984 }] },
    { edgeClass: 'corridor', name: 'D', coords: [{ lat: 4.80, lng: 6.979 }, { lat: 4.805, lng: 6.979 }] },
  ];
  const stats = analyseConnectivity(edges);
  const endpoints = edges.length * 2;
  assert.ok(stats.deadEndCount <= endpoints,
    `${stats.deadEndCount} dead ends from ${edges.length} ways (${endpoints} endpoints)`);
  assert.equal(stats.groups, 1, 'all four ways are one connected network');
});
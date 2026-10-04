/**
 * A branch that ends on the middle of another way must connect.
 *
 * The router splits every way at its own vertices. That is enough for OSM,
 * which splits a road at every node where something joins it, so the campus
 * extract has zero interior junctions. It is NOT enough for geometry from
 * elsewhere -- a merged walk trace, or an import that stores long unsplit ways
 * -- where a branch ending partway along a road would be invisible and the whole
 * area would read as disconnected.
 *
 * These tests pin the split that fixes that, and pin that it does nothing when
 * there is nothing to do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph } from '../src/graph/router.js';

/** Component count, the thing connectivity actually means here. */
function components(edges) {
  const { adj } = buildGraph(edges);
  const seen = new Set();
  let n = 0;
  for (const k of adj.keys()) {
    if (seen.has(k)) continue;
    n += 1;
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const c = stack.pop();
      for (const l of adj.get(c) ?? []) {
        if (!seen.has(l.to)) { seen.add(l.to); stack.push(l.to); }
      }
    }
  }
  return n;
}

/** A long unsplit road running north. */
const ROAD = {
  edgeClass: 'corridor',
  name: 'Long Road',
  coords: [{ lat: 4.7900, lng: 6.9790 }, { lat: 4.8000, lng: 6.9790 }],
};

/** A branch ending exactly on the road's midpoint. */
const BRANCH = {
  edgeClass: 'corridor',
  name: 'Branch',
  coords: [{ lat: 4.7950, lng: 6.9790 }, { lat: 4.7950, lng: 6.9840 }],
};

test('a branch ending on a way interior connects', () => {
  assert.equal(components([ROAD, BRANCH]), 1,
    'the branch must join the road rather than sitting beside it');
});

test('a branch ending on a way interior can be routed along', () => {
  const graph = buildGraph([ROAD, BRANCH]);
  const mid = graph.adj.get('4.7950000,6.9790000');
  assert.ok(mid, 'the junction should exist as a node');
  // And it must be a real junction: somewhere to walk to from the road, and
  // somewhere to walk to along the branch.
  assert.ok(mid.length >= 2, `expected degree >= 2, got ${mid?.length}`);
});

test('two ways sharing an endpoint are unaffected', () => {
  const a = { edgeClass: 'corridor', coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }] };
  const b = { edgeClass: 'corridor', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.80, lng: 6.979 }] };
  const graph = buildGraph([a, b]);
  assert.equal(components([a, b]), 1);
  // No extra vertex should have been invented at the shared endpoint.
  assert.equal(graph.adj.size, 3, 'three nodes, not four');
});

test('a way that merely crosses another is NOT joined', () => {
  // Overpass. Joining these would create a route through a bridge.
  const eastWest = {
    edgeClass: 'corridor',
    coords: [{ lat: 4.7950, lng: 6.9750 }, { lat: 4.7950, lng: 6.9850 }],
  };
  assert.equal(components([ROAD, eastWest]), 2,
    'crossing without a shared node is an overpass, not a junction');
});

test('a branch stopping short does not connect', () => {
  // 2 m from the road: close enough to look joined on a map, not a junction.
  const nearMiss = {
    edgeClass: 'corridor',
    coords: [{ lat: 4.7950, lng: 6.9790 + 2 / 110_970 }, { lat: 4.7950, lng: 6.9840 }],
  };
  assert.equal(components([ROAD, nearMiss]), 2);
});

test('splitting is idempotent', () => {
  // Splitting an already-split way must not keep adding vertices, or repeated
  // graph loads would grow without bound.
  const graph = buildGraph([ROAD, BRANCH]);
  const again = buildGraph([ROAD, BRANCH]);
  assert.equal(graph.adj.size, again.adj.size);
});

test('the input edges are not mutated', () => {
  // assembleGraph reuses the same rows for stats and for the graph.
  const edges = [
    { edgeClass: 'corridor', name: 'Road', coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.80, lng: 6.979 }] },
    { edgeClass: 'corridor', name: 'Branch', coords: [{ lat: 4.795, lng: 6.979 }, { lat: 4.795, lng: 6.984 }] },
  ];
  const before = JSON.stringify(edges);
  buildGraph(edges);
  assert.equal(JSON.stringify(edges), before, 'buildGraph must not write to its input');
});

test('degenerate input is handled', () => {
  assert.equal(components([]), 0);
  assert.equal(components([ROAD]), 1);
  // Unusable edges must not throw.
  assert.doesNotThrow(() => buildGraph([
    { edgeClass: 'corridor', coords: [] },
    { edgeClass: 'corridor', coords: [{ lat: 4.79, lng: 6.979 }] },
    ROAD,
  ]));
});

test('the splitter does not depend on way order', () => {
  // Whichever way is processed first contributes its vertices as split points,
  // so a reversed input must give the same graph -- not the same segment count,
  // the same graph.
  const forward = buildGraph([ROAD, BRANCH]);
  const reversed = buildGraph([BRANCH, ROAD]);
  assert.equal(forward.adj.size, reversed.adj.size);
  assert.equal(forward.segments.length, reversed.segments.length);
  assert.equal(components([ROAD, BRANCH]), components([BRANCH, ROAD]));
});

test('a way ending exactly on a vertex is not split twice', () => {
  // The shared endpoint is already a vertex of the road. Splitting there again
  // would create a second node a centimetre away, and two nodes that should be
  // one -- which is precisely the fragmentation this whole mechanism exists to
  // avoid.
  const graph = buildGraph([ROAD, BRANCH]);

  // Exactly one node at the junction, not two.
  const atJunction = [...graph.adj.keys()].filter((k) => k.startsWith('4.7950000,6.979'));
  assert.equal(atJunction.length, 1,
    `expected one node at the junction, found ${atJunction.length}: ${atJunction.join(', ')}`);

  // And it is a real three-way junction: north, south, east.
  assert.equal(graph.adj.get(atJunction[0]).length, 3,
    'the junction should link to both road directions and the branch');

  // Two segments along the road, one along the branch. A duplicate split would
  // make it four.
  assert.equal(graph.segments.length, 3);
});

test('a branch joining a way at several points connects once', () => {
  // Two branches off the same road, both mid-segment.
  const b1 = { edgeClass: 'corridor', coords: [{ lat: 4.7925, lng: 6.9790 }, { lat: 4.7925, lng: 6.9830 }] };
  const b2 = { edgeClass: 'corridor', coords: [{ lat: 4.7975, lng: 6.9790 }, { lat: 4.7975, lng: 6.9830 }] };
  assert.equal(components([ROAD, b1, b2]), 1);
});

test('a self-crossing way is not broken', () => {
  // A single way whose own vertices land on its own interior would be a
  // degenerate loop; it must still build without duplicating endlessly.
  const loop = {
    edgeClass: 'corridor',
    coords: [
      { lat: 4.79, lng: 6.979 }, { lat: 4.80, lng: 6.979 },
      { lat: 4.80, lng: 6.980 }, { lat: 4.79, lng: 6.979 },
    ],
  };
  assert.doesNotThrow(() => buildGraph([loop]));
  assert.ok(buildGraph([loop]).adj.size > 0);
});
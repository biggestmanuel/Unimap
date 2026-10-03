/**
 * Endpoint snapping tests.
 *
 * The problem this solves: a person walking with a phone does not stop on a
 * surveyed vertex. A genuine recording of a genuine path lands metres away from
 * every node, so the merged edge becomes another island -- which looks like the
 * map improved when nothing became routable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { snapEndpoints, SNAP_TOLERANCE_METERS } from '../src/graph/snap.js';
import { buildGraph } from '../src/graph/router.js';
import { haversineMeters } from '../src/graph/geo.js';

/** A single straight road, north-south. */
const ROAD = {
  edgeClass: 'corridor',
  name: 'Campus Road',
  coords: [
    { lat: 4.7900, lng: 6.9790 },
    { lat: 4.7950, lng: 6.9790 },
    { lat: 4.8000, lng: 6.9790 },
  ],
};

const graph = buildGraph([ROAD]);

/**
 * A point `metres` EAST of the road, level with its midpoint.
 *
 * Offset east rather than north deliberately: the road runs north from 4.7900
 * to 4.8000, so a point placed north of 4.7950 is still on the road and
 * snapping correctly declines to move it. That is a trap worth avoiding in a
 * test whose whole subject is "a point that is off the road".
 */
function besideRoad(metres, at = 4.7950) {
  return { lat: at, lng: 6.9790 + metres / 110_970 };
}

test('an endpoint beside the road is pulled onto it', () => {
  const coords = [besideRoad(8), { lat: 4.7950, lng: 6.9795 }, besideRoad(6)];
  const { coords: out, snapped } = snapEndpoints(coords, graph);

  assert.equal(snapped.length, 2, 'both ends should have moved');
  for (const s of snapped) {
    assert.ok(s.meters > 5 && s.meters < 9, `snapped ${s.meters.toFixed(1)}m`);
  }
  // Each end now lies on the road.
  assert.ok(haversineMeters(out[0], ROAD.coords[1]) < 1);
  assert.ok(haversineMeters(out[2], ROAD.coords[1]) < 1);
});

test('the middle of the walk is never moved', () => {
  // The middle is the new information. Snapping it onto the road would delete
  // the path instead of connecting it.
  const coords = [besideRoad(8), { lat: 4.7950, lng: 6.9805 }, besideRoad(6)];
  const { coords: out } = snapEndpoints(coords, graph);

  assert.deepEqual(out[1], coords[1], 'the middle point must be untouched');
  assert.notDeepEqual(out[0], coords[0], 'the first end should have moved');
});

test('nothing happens when the endpoints are already on the network', () => {
  const coords = [ROAD.coords[0], { lat: 4.7950, lng: 6.9805 }, ROAD.coords[2]];
  const { coords: out, snapped } = snapEndpoints(coords, graph);

  assert.equal(snapped.length, 0, 'no snap should be reported');
  assert.deepEqual(out, coords, 'geometry must be unchanged');
});

test('an endpoint beyond the tolerance is left alone', () => {
  const far = { lat: 4.7950 + 200 / 111_320, lng: 6.9790 };
  const coords = [far, { lat: 4.7950, lng: 6.9795 }, ROAD.coords[2]];
  const { coords: out, snapped } = snapEndpoints(coords, graph);

  assert.equal(snapped.length, 0, '200 m away is not a connection');
  assert.deepEqual(out[0], far);
});

test('a custom tolerance is honoured', () => {
  const near = besideRoad(15);
  const coords = [near, { lat: 4.7950, lng: 6.9795 }, ROAD.coords[2]];

  assert.equal(snapEndpoints(coords, graph, 5).snapped.length, 0, '15m exceeds 5m');
  assert.equal(snapEndpoints(coords, graph, 20).snapped.length, 1, '15m is inside 20m');
  assert.equal(snapEndpoints(coords, graph).snapped.length, 1, '15m is inside the default');
});

test('a point beside the road but north of a vertex still snaps', () => {
  // Guards the trap in the helper above: sitting on the road's line further
  // north is NOT "off the road", and must not be reported as a snap.
  const alongButOffset = { lat: 4.7960, lng: 6.9790 + 7 / 110_970 };
  const coords = [alongButOffset, { lat: 4.7950, lng: 6.9795 }, ROAD.coords[2]];
  const { snapped } = snapEndpoints(coords, graph);
  assert.equal(snapped.length, 1, '7m east of the road is a genuine snap');
  assert.ok(snapped[0].meters > 6 && snapped[0].meters < 8,
    `expected about 7m, got ${snapped[0].meters.toFixed(2)}`);
});

test('the default tolerance is a sane road width', () => {
  assert.ok(SNAP_TOLERANCE_METERS >= 10 && SNAP_TOLERANCE_METERS <= 50,
    `${SNAP_TOLERANCE_METERS}m should be wide enough for GPS error, not a whole field`);
});

test('an endpoint snaps to the nearest point, not the nearest vertex', () => {
  // Halfway along a segment is the common case, and the closest point there is
  // mid-segment. Snapping to a vertex instead would drag the walk sideways.
  const coords = [
    { lat: 4.7925, lng: 6.9790 + 6 / 110_970 },  // 6 m east, mid-segment
    { lat: 4.7950, lng: 6.9795 },
    ROAD.coords[2],
  ];
  const { coords: out, snapped } = snapEndpoints(coords, graph);

  assert.equal(snapped.length, 1);
  // The latitude must be unchanged: snapping only removes the east offset. If
  // this snapped to the nearest vertex instead, the point would be dragged
  // north to 4.7900 or 4.7950.
  assert.ok(Math.abs(out[0].lat - 4.7925) < 1e-9,
    `latitude should be untouched, got ${out[0].lat}`);
  assert.ok(Math.abs(out[0].lng - 6.9790) < 1e-9,
    `longitude should land on the road, got ${out[0].lng}`);
  assert.ok(haversineMeters(out[0], { lat: 4.7925, lng: 6.9790 }) < 1, 'should land on the road');
});

test('degenerate input is handled without throwing', () => {
  assert.equal(snapEndpoints([], graph).snapped.length, 0);
  assert.equal(snapEndpoints([{ lat: 1, lng: 1 }], graph).snapped.length, 0);
  // No graph at all: return the input untouched rather than guessing.
  const coords = [besideRoad(8), besideRoad(-8)];
  const { coords: out, snapped } = snapEndpoints(coords, null);
  assert.equal(snapped.length, 0);
  assert.deepEqual(out, coords);
});

test('an empty graph does not snap anything', () => {
  const coords = [{ lat: 4.79, lng: 6.979 }, { lat: 4.80, lng: 6.979 }];
  const { snapped } = snapEndpoints(coords, buildGraph([]));
  assert.equal(snapped.length, 0);
});

test('only the ends move even on a long walk', () => {
  const coords = [
    besideRoad(5),
    { lat: 4.7920, lng: 6.9795 },
    { lat: 4.7940, lng: 6.9795 },
    { lat: 4.7960, lng: 6.9795 },
    { lat: 4.7980, lng: 6.9795 },
    besideRoad(5),
  ];
  const { coords: out, snapped } = snapEndpoints(coords, graph);

  assert.equal(snapped.length, 2);
  for (let i = 1; i < out.length - 1; i += 1) {
    assert.deepEqual(out[i], coords[i], `interior point ${i} must be untouched`);
  }
});

test('snapping reports the distance it moved', () => {
  const coords = [besideRoad(12), { lat: 4.7950, lng: 6.9795 }, ROAD.coords[2]];
  const { snapped } = snapEndpoints(coords, graph);

  assert.equal(snapped.length, 1);
  const s = snapped[0];
  assert.equal(s.index, 0, 'records which end moved');
  assert.ok(Math.abs(s.meters - 12) < 1, `expected about 12m, got ${s.meters.toFixed(2)}`);
  assert.deepEqual(s.from, coords[0], 'records where it came from');
  assert.ok(s.to, 'records where it went');
});
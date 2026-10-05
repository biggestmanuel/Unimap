import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, findRoute, snapCandidates, snapToGraph } from '../src/graph/router.js';

/**
 * Reproduces a real campus failure.
 *
 * `graph_edges` holds 324 ways, 42 of which form islands not attached to the
 * main network -- a short driveway, a footpath from a recorded walk whose
 * endpoints never met anything. A student standing near one of those islands is
 * closest to the island, and the router used to stop there:
 *
 *   - both ends snap to geometry
 *   - those two pieces sit in different connected components
 *   - `searchBetween` finds no path
 *   - the response is a straight line labelled `network_disconnected`
 *
 * The straight line is not merely ugly, it is a false claim: a real path
 * existed a couple of metres away. These tests build that situation and assert
 * the router now finds the real path.
 *
 * Distances are written in metres and converted, because a 20 m offset written
 * as 0.0002 degrees is 22 m while 0.002 is 220 m -- and the first draft of
 * this file got that wrong in a way that silently made every test vacuous.
 */
const DEG_PER_METER = 1 / 110_900; // ~111 km per degree at 4.8 deg N
const m = (metres) => metres * DEG_PER_METER;

const MAIN_S = 4.7800;
const MAIN_N = 4.8000;
const MAIN_E = 6.9790;
const ORIGIN = { lat: 4.7900, lng: MAIN_E };

/** A 2.2 km north-south road through the origin. */
const mainRoad = (id = 'main') => ({
  id,
  name: 'Main Road',
  edgeClass: 'corridor',
  coords: [
    { lat: MAIN_S, lng: MAIN_E },
    { lat: 4.7900, lng: MAIN_E },
    { lat: MAIN_N, lng: MAIN_E },
  ],
});

/** A 30 m driveway 20 m east of the main road. Touches nothing. */
const stub = {
  id: 'stub',
  name: 'Staff Car Park Spur',
  edgeClass: 'footpath',
  coords: [
    { lat: 4.7950, lng: MAIN_E + m(20) },
    { lat: 4.79513, lng: MAIN_E + m(20) },
  ],
};

/** 5 m from the stub, 25 m from the main road -- so the island wins the snap. */
const NEAR_STUB = { lat: 4.79513, lng: MAIN_E + m(25) };

test('a route is found even when the closest geometry to one end is an island', () => {
  const graph = buildGraph([mainRoad(), stub]);

  const closest = snapToGraph(NEAR_STUB, graph, { maxDistanceMeters: 50 });
  assert.ok(closest, 'the destination must snap to something');
  assert.equal(
    closest.segment.name,
    'Staff Car Park Spur',
    'precondition: the island is the closest geometry, which is the whole point',
  );

  const route = findRoute(graph, ORIGIN, NEAR_STUB, { maxSnapMeters: 50 });

  assert.equal(route.found, true, 'a real path exists, so the router must use it');
  assert.notEqual(route.reason, 'network_disconnected');
  assert.ok(route.distanceMeters > 0);
  // 555 m up the road plus 25 m across. Anything campus-sized is fine; a
  // straight line would be ~1.2 km, and a return of Infinity is the old bug.
  assert.ok(
    route.distanceMeters < 800,
    `expected a campus-scale route, got ${route.distanceMeters}m`,
  );
  assert.ok(route.legs.length > 0, 'a found route must have directions');
});

test('the alternative is priced, not just the first connected pair', () => {
  // Two ways to the destination. The *nearer* geometry is the long way round,
  // so the cheap route is only found if every candidate pair is costed rather
  // than the first success being accepted.
  const longWay = {
    id: 'long',
    name: 'Long Way Round',
    edgeClass: 'corridor',
    coords: [
      { lat: MAIN_S, lng: MAIN_E },
      { lat: MAIN_S, lng: MAIN_E + m(11) },
      { lat: MAIN_N, lng: MAIN_E + m(11) },
      { lat: MAIN_N, lng: MAIN_E },
    ],
  };

  const graph = buildGraph([mainRoad(), longWay]);

  // 3 m from the detour, 14 m from the direct road.
  const destination = { lat: 4.7950, lng: MAIN_E + m(14) };

  const first = snapCandidates(destination, graph, { maxDistanceMeters: 50 });
  assert.equal(
    first[0].segment.name,
    'Long Way Round',
    'precondition: the expensive route is tried first',
  );

  const route = findRoute(graph, ORIGIN, destination, { maxSnapMeters: 50 });
  assert.equal(route.found, true);
  // Direct: 555 m up the road plus 14 m across. Via the detour: ~1.7 km.
  assert.ok(
    route.distanceMeters < 900,
    `the cheaper candidate must win, got ${route.distanceMeters}m`,
  );
});

test('two components with no nearby bridge still report disconnected', () => {
  // A road 300 m east. Nothing within snapping range links it, so no candidate
  // pairing can succeed and the honest answer is still a straight line. This is
  // the branch that must NOT be papered over -- reporting a route here would
  // draw a line through a building.
  const farRoad = {
    id: 'far',
    name: 'Parallel Road',
    edgeClass: 'corridor',
    coords: [
      { lat: MAIN_S, lng: MAIN_E + m(300) },
      { lat: MAIN_N, lng: MAIN_E + m(300) },
    ],
  };

  const graph = buildGraph([mainRoad(), farRoad]);
  const route = findRoute(graph, ORIGIN, { lat: 4.7950, lng: MAIN_E + m(300) }, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, false);
  assert.equal(route.reason, 'network_disconnected');
});

test('a destination beyond the snap radius is still reported as off-network', () => {
  const graph = buildGraph([mainRoad(), stub]);
  const route = findRoute(graph, ORIGIN, { lat: 4.7950, lng: MAIN_E + m(400) }, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, false);
  assert.equal(route.reason, 'destination_off_network');
});

test('an origin beyond the snap radius is still reported as off-network', () => {
  const graph = buildGraph([mainRoad(), stub]);
  const route = findRoute(graph, { lat: 4.7950, lng: MAIN_E + m(400) }, ORIGIN, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, false);
  assert.equal(route.reason, 'origin_off_network');
});

test('snapCandidates returns the nearest few, closest first', () => {
  const graph = buildGraph([mainRoad(), stub]);
  const cands = snapCandidates(NEAR_STUB, graph, { maxDistanceMeters: 50 });

  assert.ok(cands.length >= 2, 'both the stub and the main road are in range');
  assert.equal(cands[0].segment.name, 'Staff Car Park Spur');

  for (let i = 1; i < cands.length; i += 1) {
    assert.ok(
      cands[i].distanceMeters >= cands[i - 1].distanceMeters,
      'candidates must be ordered by distance',
    );
  }
});

test('snapCandidates never returns a position outside maxDistanceMeters', () => {
  const graph = buildGraph([mainRoad(), stub]);
  for (const c of snapCandidates(NEAR_STUB, graph, { maxDistanceMeters: 12 })) {
    assert.ok(c.distanceMeters <= 12, `${c.distanceMeters}m exceeded the limit`);
  }
});

test('a fan of ways from one junction collapses to a single candidate', () => {
  // Every projection lands on the shared node, so they are all the same
  // position. Searching all of them buys nothing and would push genuinely
  // different alternatives past the limit.
  //
  // The three spurs must diverge. An earlier draft of this test aimed them all
  // down the same bearing, which made them overlap exactly; `buildGraph` then
  // chained them into one way and the test asserted nothing useful.
  const fan = [
    { name: 'North Spur', offset: { lat: m(30), lng: 0 } },
    { name: 'East Spur', offset: { lat: 0, lng: m(30) } },
    { name: 'South Spur', offset: { lat: -m(30), lng: m(30) } },
  ].map(({ name, offset }, i) => ({
    id: `fan-${i}`,
    name,
    edgeClass: 'footpath',
    coords: [
      { lat: 4.7900, lng: MAIN_E },
      { lat: 4.7900 + offset.lat, lng: MAIN_E + offset.lng },
    ],
  }));

  const graph = buildGraph([mainRoad(), ...fan]);
  const cands = snapCandidates(ORIGIN, graph, { maxDistanceMeters: 50, limit: 3 });

  const names = cands.map((c) => c.segment.name);

  // All three spurs leave the junction, so all three project onto it, so all
  // three collapse into the one position they share. None may survive as a
  // separate candidate -- that is the whole point.
  for (const spur of ['North Spur', 'East Spur', 'South Spur']) {
    assert.ok(
      !names.includes(spur),
      `${spur} is the junction restated, so it must not be a separate candidate`,
    );
  }

  assert.equal(
    cands.filter((c) => c.distanceMeters === 0).length,
    1,
    'the junction must appear exactly once, at zero distance',
  );
});

test('a split point on the same road is still a distinct candidate', () => {
  // The counterweight to the test above: collapsing must not swallow geometry
  // that merely *starts* at the same place. `buildGraph` splits Main Road where
  // North Spur's far end lands mid-segment, and that split point is a real
  // position 30 m up the road.
  const northSpur = {
    id: 'north',
    name: 'North Spur',
    edgeClass: 'footpath',
    coords: [
      { lat: 4.7900, lng: MAIN_E },
      { lat: 4.7900 + m(30), lng: MAIN_E },
    ],
  };

  const graph = buildGraph([mainRoad(), northSpur]);
  const cands = snapCandidates(ORIGIN, graph, { maxDistanceMeters: 50, limit: 3 });

  assert.equal(cands.length, 2, 'the junction, and the road 30 m north of it');
  assert.equal(cands[0].distanceMeters, 0);
  assert.ok(
    Math.abs(cands[1].distanceMeters - 30) < 1,
    `expected ~30m, got ${cands[1].distanceMeters}m`,
  );
});

test('a far-away alternative still survives the collapse', () => {
  // The same fan, plus one genuinely separate piece of geometry. If collapsing
  // were applied without a limit it would swallow everything.
  const elsewhere = {
    id: 'elsewhere',
    name: 'Elsewhere Walk',
    edgeClass: 'footpath',
    coords: [
      { lat: 4.7900, lng: MAIN_E + m(30) },
      { lat: 4.7901, lng: MAIN_E + m(30) },
    ],
  };

  const graph = buildGraph([mainRoad(), elsewhere]);
  const cands = snapCandidates(ORIGIN, graph, { maxDistanceMeters: 50, limit: 6 });

  const names = cands.map((c) => c.segment.name);
  assert.ok(names.includes('Elsewhere Walk'), `got ${names.join(', ')}`);
});

test('every node is labelled with a component', () => {
  // `findRoute` uses this to skip pairings that cannot connect, which is what
  // keeps a fallback costing microseconds instead of ~200 ms. If the labelling
  // ever stops covering the graph, the cost returns silently.
  const graph = buildGraph([mainRoad(), stub]);

  assert.ok(graph.component, 'buildGraph must label components');
  assert.equal(
    graph.component.size,
    graph.adj.size,
    'every node in the adjacency must have a label',
  );
  assert.equal(new Set(graph.component.values()).size, 2, 'road and stub are two');
});

test('a candidate reports the component it sits in', () => {
  const graph = buildGraph([mainRoad(), stub]);

  const nearStub = snapCandidates(NEAR_STUB, graph, { maxDistanceMeters: 50 });
  const onRoadAll = snapCandidates(ORIGIN, graph, { maxDistanceMeters: 50 });

  const onStub = nearStub.find((c) => c.segment.name === 'Staff Car Park Spur');
  const onRoad = onRoadAll.find((c) => c.segment.name === 'Main Road');

  assert.ok(onStub && onRoad);
  assert.ok(
    onStub.component !== onRoad.component,
    'the router must be able to tell these two apart without searching',
  );
  assert.ok(
    onStub.component !== null && onRoad.component !== null,
    'both labels must be real, not a fallback null',
  );
});

test('the road is a candidate even though the island is nearer', () => {
  // The regression guard for the whole change. With a single snap the island
  // wins and the route fails; the fix is that the road is considered too.
  const graph = buildGraph([mainRoad(), stub]);
  const names = snapCandidates(NEAR_STUB, graph, { maxDistanceMeters: 50 })
    .map((c) => c.segment.name);

  assert.ok(names.includes('Staff Car Park Spur'), 'nearest');
  assert.ok(names.includes('Main Road'), 'second');
});

test('an ordinary route along one road is not altered by the fix', () => {
  // Both ends on the same road, so the nearest snap is the right one and the
  // answer must be the plain distance along it.
  const graph = buildGraph([mainRoad()]);
  const route = findRoute(graph, { lat: 4.7850, lng: MAIN_E }, NEAR_STUB, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, true);
  // 4.7850 to 4.7950 is 0.01 deg, ~1109 m, then 25 m across the grass.
  assert.ok(
    Math.abs(route.distanceMeters - 1134) < 20,
    `expected ~1134m, got ${route.distanceMeters}m`,
  );
});

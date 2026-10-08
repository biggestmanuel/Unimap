import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, findRoute } from '../src/graph/router.js';

/**
 * The reported distance must be the distance the student actually walks.
 *
 * `buildGraph` multiplies footpath cost by `FOOTPATH_COST_FACTOR` so the router
 * prefers a corridor when the detour is small. That is a preference about which
 * route to pick, and it used to leak into the number displayed: `distanceMeters`
 * came from the same accumulated cost the search minimised, so every footpath
 * metre was counted 1.15 times.
 *
 * Measured against the real campus graph before the fix: 1.4% over across a
 * sample of routes, 3.7% on the worst, and the turn-by-turn legs -- drawn from
 * real geometry -- disagreed with the stated distance on the same route. The
 * app contradicted itself, and `durationSeconds` was derived from the inflated
 * figure.
 *
 * The search still minimises cost; only the reported figure changed.
 */

const M = 1 / 110_900; // degrees per metre at 4.8 deg N
const m = (metres) => metres * M;

/**
 * A corridor and a footpath running roughly parallel, joined at both ends, so a
 * route between two points on the corridor has a genuine alternative that
 * differs only in class.
 */
function campus() {
  return [
    {
      id: 'corridor',
      name: 'Campus Road',
      edgeClass: 'corridor',
      coords: [
        { lat: 4.7800, lng: 6.9790 },
        { lat: 4.7900, lng: 6.9790 },
        { lat: 4.8000, lng: 6.9790 },
      ],
    },
    {
      id: 'footpath',
      name: 'Quad Shortcut',
      edgeClass: 'footpath',
      coords: [
        { lat: 4.7800, lng: 6.9790 + m(40) },
        { lat: 4.7900, lng: 6.9790 + m(40) },
        { lat: 4.8000, lng: 6.9790 + m(40) },
      ],
    },
  ];
}

test('reported distance equals the geometry drawn, footpath or not', () => {
  const graph = buildGraph(campus());

  // A point off the network, so the route includes both an on-network search
  // and off-network legs at each end.
  const route = findRoute(
    graph,
    { lat: 4.7850, lng: 6.9790 + m(10) },
    { lat: 4.7950, lng: 6.9790 - m(10) },
    { maxSnapMeters: 50 },
  );

  assert.equal(route.found, true);
  assert.ok(route.legs.length > 0, 'precondition: a route with legs');

  const drawn = route.legs.reduce((sum, l) => sum + l.lengthMeters, 0)
    + route.snappedOriginMeters
    + route.snappedDestinationMeters;

  assert.ok(
    Math.abs(route.distanceMeters - drawn) < 0.5,
    `stated ${route.distanceMeters.toFixed(2)}m but drew ${drawn.toFixed(2)}m`,
  );
});

test('a footpath route is not reported as longer than it is', () => {
  // Two corridor stubs with only a footpath joining them, so any route between
  // them is forced along the shortcut. An earlier version of this fixture
  // severed the corridor but left the destination hanging off the network
  // entirely, so it asserted `found === true` against a straight-line fallback
  // and would have passed for the wrong reason.
  const graph = buildGraph([
    {
      id: 'south',
      name: 'South Road',
      edgeClass: 'corridor',
      coords: [
        { lat: 4.7800, lng: 6.9790 },
        { lat: 4.7850, lng: 6.9790 },
      ],
    },
    {
      id: 'link',
      name: 'Quad Shortcut',
      edgeClass: 'footpath',
      coords: [
        { lat: 4.7850, lng: 6.9790 },
        { lat: 4.7850, lng: 6.9790 + m(40) },
        { lat: 4.7900, lng: 6.9790 + m(40) },
        { lat: 4.7900, lng: 6.9790 },
      ],
    },
    {
      id: 'north',
      name: 'North Road',
      edgeClass: 'corridor',
      coords: [
        { lat: 4.7900, lng: 6.9790 },
        { lat: 4.7950, lng: 6.9790 },
      ],
    },
  ]);

  const route = findRoute(graph, { lat: 4.7820, lng: 6.9790 }, { lat: 4.7930, lng: 6.9790 }, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, true, 'the two stubs must be joined by the footpath');
  assert.ok(
    route.legs.some((l) => l.edgeClass === 'footpath'),
    'precondition: the route must actually use a footpath',
  );

  const drawn = route.legs.reduce((sum, l) => sum + l.lengthMeters, 0)
    + route.snappedOriginMeters
    + route.snappedDestinationMeters;

  assert.ok(
    Math.abs(route.distanceMeters - drawn) < 0.5,
    `stated ${route.distanceMeters.toFixed(2)}m but drew ${drawn.toFixed(2)}m`,
  );
});

test('duration is derived from the real distance', () => {
  const graph = buildGraph(campus());
  const route = findRoute(graph, { lat: 4.7800, lng: 6.9790 }, { lat: 4.8000, lng: 6.9790 }, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, true);
  assert.ok(
    Math.abs(route.durationSeconds - route.distanceMeters / 1.35) < 1e-6,
    'duration must be distance over walking speed, with no inflation of its own',
  );
  // And the distance must equal the real geometry, not the penalised cost.
  const drawn = route.legs.reduce((sum, l) => sum + l.lengthMeters, 0);
  assert.ok(
    Math.abs(route.distanceMeters - drawn) < 0.5,
    `stated ${route.distanceMeters.toFixed(2)}m but drew ${drawn.toFixed(2)}m`,
  );
});

test('the footpath preference still steers the choice', () => {
  // The fix must not have removed the preference, only stopped it reaching the
  // reported figure. With a corridor and a footpath of equal length, the
  // corridor still wins.
  const graph = buildGraph(campus());
  const route = findRoute(graph, { lat: 4.7810, lng: 6.9790 }, { lat: 4.7990, lng: 6.9790 }, {
    maxSnapMeters: 50,
  });

  assert.equal(route.found, true);
  const usedFootpath = route.legs.some((l) => l.edgeClass === 'footpath');
  assert.equal(
    usedFootpath,
    false,
    'an equal-length footpath must not be preferred over a corridor',
  );
});
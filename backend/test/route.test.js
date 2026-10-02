/**
 * HTTP tests for routing and graph introspection.
 *
 * Both repositories are in-memory, so this needs neither Postgres nor a
 * network. The fixture graph is a miniature L-shaped campus: one road with a
 * branch, plus a disconnected island to prove the fallbacks work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { createMemoryGraphRepo } from '../src/graph/graphRepo.js';

const ORIGIN = { lat: 4.79, lng: 6.98 };

function offset(origin, northMeters, eastMeters) {
  return {
    lat: origin.lat + northMeters / 111320,
    lng: origin.lng + eastMeters / (111320 * Math.cos(origin.lat * Math.PI / 180)),
  };
}

const GRAPH_ROWS = [
  {
    osmId: 1,
    name: 'Road A',
    edgeClass: 'corridor',
    surface: 'paved',
    coords: [ORIGIN, offset(ORIGIN, 200, 0), offset(ORIGIN, 400, 0)],
  },
  {
    osmId: 2,
    name: 'Road B',
    edgeClass: 'corridor',
    surface: 'paved',
    coords: [offset(ORIGIN, 200, 0), offset(ORIGIN, 200, 300)],
  },
  {
    osmId: 3,
    name: 'Quad path',
    edgeClass: 'footpath',
    surface: null,
    coords: [ORIGIN, offset(ORIGIN, 200, 300)],
  },
  // Unreachable: shares no vertex with anything.
  {
    osmId: 4,
    name: 'Orphan lane',
    edgeClass: 'corridor',
    surface: null,
    coords: [offset(ORIGIN, 900, 0), offset(ORIGIN, 1000, 0)],
  },
];

const POI_SEED = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'NEH', lat: offset(ORIGIN, 10, 0).lat, lng: offset(ORIGIN, 10, 0).lng },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Maracana', lat: offset(ORIGIN, 390, 0).lat, lng: offset(ORIGIN, 390, 0).lng },
];

function build() {
  const repo = createMemoryRepo(POI_SEED);
  const graphRepo = createMemoryGraphRepo(GRAPH_ROWS);
  return { app: createApp({ repo, graphRepo }), repo, graphRepo };
}

// ── validation ─────────────────────────────────────────────────────────
test('POST /api/route rejects a missing body', async () => {
  const { app } = build();
  const res = await request(app).post('/api/route').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_route');
  assert.ok(res.body.fields.from);
});

test('POST /api/route rejects an out-of-range coordinate', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: { lat: 999, lng: 0 }, to: { lat: 4.79, lng: 6.98 } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_route');
});

test('POST /api/route rejects a non-uuid poi reference', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: { poiId: 'not-a-uuid' }, to: { lat: 4.79, lng: 6.98 } });
  assert.equal(res.status, 400);
});

test('POST /api/route caps maxSnapMeters so a snap cannot be absurd', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: { lat: 4.79, lng: 6.98 }, to: { lat: 4.80, lng: 6.98 }, maxSnapMeters: 5000 });
  assert.equal(res.status, 400);
});

// ── routing ────────────────────────────────────────────────────────────
test('POST /api/route walks along the network', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: { lat: ORIGIN.lat, lng: ORIGIN.lng }, to: offset(ORIGIN, 390, 0) });

  assert.equal(res.status, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.mode, 'graph');
  assert.ok(res.body.distanceMeters > 370, `got ${res.body.distanceMeters}`);
  assert.ok(res.body.durationSeconds > 0);
  assert.ok(res.body.coords.length >= 2);
  // Every coordinate carries both keys, in a consistent order.
  for (const p of res.body.coords) {
    assert.equal(typeof p.lat, 'number');
    assert.equal(typeof p.lng, 'number');
  }
});

test('POST /api/route returns legs with way names', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 390, 0), to: offset(ORIGIN, 200, 290) });

  assert.equal(res.body.found, true);
  const names = new Set(res.body.legs.map((l) => l.name));
  assert.ok(names.has('Road A'), `legs were ${[...names].join(', ')}`);
  assert.ok(names.has('Road B'));
  for (const leg of res.body.legs) {
    assert.ok(leg.coords.length >= 2);
    assert.ok(Number.isFinite(leg.lengthMeters));
  }
});

test('POST /api/route prefers the footpath shortcut', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 5, 5), to: offset(ORIGIN, 195, 295) });

  assert.equal(res.body.found, true);
  const classes = res.body.legs.map((l) => l.edgeClass);
  assert.ok(classes.includes('footpath'), `legs were ${classes.join(',')}`);
  assert.ok(res.body.distanceMeters < 400, `got ${res.body.distanceMeters}`);
});

test('POST /api/route accepts POI ids at either end', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({
      from: { poiId: '11111111-1111-4111-8111-111111111111' },
      to: { poiId: '22222222-2222-4222-8222-222222222222' },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.from.source, 'poi');
  assert.equal(res.body.from.name, 'NEH');
  assert.equal(res.body.to.name, 'Maracana');
});

test('POST /api/route mixes a POI with a raw GPS fix', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({
      from: { poiId: '11111111-1111-4111-8111-111111111111' },
      to: offset(ORIGIN, 380, 0),
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.from.source, 'poi');
  assert.equal(res.body.to.source, 'coordinate');
  assert.equal(res.body.found, true);
});

test('POST /api/route 404s on an unknown POI', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({
      from: { poiId: '99999999-9999-4999-8999-999999999999' },
      to: { lat: 4.79, lng: 6.98 },
    });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'endpoint_not_found');
  assert.ok(res.body.fields.from);
});

// ── fallbacks ──────────────────────────────────────────────────────────
test('POST /api/route falls back to a straight line, with 200 not 500', async () => {
  const { app } = build();
  // Both ends well clear of every way in the fixture graph.
  const res = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, -500, 500), to: offset(ORIGIN, 650, -500) });

  // Far enough that nothing snaps.
  assert.equal(res.status, 200, 'a fallback is an answer, not an error');
  assert.equal(res.body.found, false);
  assert.equal(res.body.mode, 'straight_line');
  assert.ok(res.body.distanceMeters > 0);
});

test('POST /api/route reports disconnection when both ends snap but no path exists', async () => {
  const { app } = build();
  // One end on the main network, one on the island. Both snap cleanly, but
  // the two components never meet -- this is the case a straight line would
  // silently get wrong, so it must be reported rather than fudged.
  const res = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 200, 0), to: offset(ORIGIN, 950, 0) });

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'straight_line');
  assert.equal(res.body.reason, 'network_disconnected');
});

test('POST /api/route still routes two points on the same isolated way', async () => {
  const { app } = build();
  const res = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 910, 0), to: offset(ORIGIN, 990, 0) });

  assert.equal(res.body.found, true);
  assert.equal(res.body.mode, 'graph');
  assert.equal(res.body.legs[0].name, 'Orphan lane');
});

test('POST /api/route honours a tight maxSnapMeters', async () => {
  const { app } = build();
  // 30 m off the network: fine at the default, refused when tightened.
  const loose = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 100, 30), to: offset(ORIGIN, 390, 0) });
  assert.equal(loose.body.found, true);

  const tight = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 100, 30), to: offset(ORIGIN, 390, 0), maxSnapMeters: 5 });
  assert.equal(tight.body.found, false);
  assert.equal(tight.body.reason, 'origin_off_network');
});

// ── graph stats ────────────────────────────────────────────────────────
test('GET /api/graph/stats reports connectivity', async () => {
  const { app } = build();
  const res = await request(app).get('/api/graph/stats');

  assert.equal(res.status, 200);
  assert.equal(res.body.totalWays, 4);
  assert.equal(res.body.connectedGroups, 2);
  assert.equal(res.body.mainWays, 3);
  assert.ok(res.body.totalMeters > 0, 'meters must be a real number, not NaN/null');
  assert.ok(res.body.routableMeters > 0);
  assert.ok(res.body.routableMeters <= res.body.totalMeters);
  assert.equal(res.body.byClass.length, 2);
  for (const c of res.body.byClass) {
    assert.ok(Number.isFinite(c.meters), `${c.edgeClass} meters was ${c.meters}`);
  }
});

test('GET /api/graph/stats lists islands', async () => {
  const { app } = build();
  const res = await request(app).get('/api/graph/stats');

  assert.equal(res.body.islandCount, 1);
  assert.equal(res.body.islands[0].names[0], 'Orphan lane');
});

test('GET /api/graph/stats can omit the island breakdown', async () => {
  const { app } = build();
  const res = await request(app).get('/api/graph/stats?islands=false');
  assert.equal(res.body.islands.length, 0);
  assert.equal(res.body.islandCount, 1);
});

// ── resilience ─────────────────────────────────────────────────────────
test('the app boots without a graph repository and still answers /route', async () => {
  const repo = createMemoryRepo(POI_SEED);
  const app = createApp({ repo }); // no graphRepo at all

  const res = await request(app)
    .post('/api/route')
    .send({ from: offset(ORIGIN, 10, 0), to: offset(ORIGIN, 390, 0) });

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'straight_line');

  const stats = await request(app).get('/api/graph/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.totalWays, 0);
});

test('the app boots without a graph repository and still lists POIs', async () => {
  const repo = createMemoryRepo(POI_SEED);
  const app = createApp({ repo });
  const res = await request(app).get('/api/pois');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
});

test('graph stats survive an empty graph', async () => {
  const app = createApp({
    repo: createMemoryRepo(),
    graphRepo: createMemoryGraphRepo([]),
  });
  const res = await request(app).get('/api/graph/stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalWays, 0);
  assert.equal(res.body.totalMeters, 0);
});
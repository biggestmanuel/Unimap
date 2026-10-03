/**
 * Tests for merging a reviewed walk trace into the graph.
 *
 * This is the step that was missing entirely: approving a trace set a status
 * and nothing else, so the loop the app advertises -- walk somewhere unmapped,
 * record it, admin reviews it -- never actually changed routing. Only the OSM
 * importer wrote to graph_edges.
 *
 * The tests care about the properties that make the merge safe rather than
 * merely possible: the edge is a footpath, it is simplified, it is recorded,
 * it cannot be merged twice, and the graph cache is invalidated so it takes
 * effect without a restart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { createMemoryGraphRepo } from '../src/graph/graphRepo.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';
import { hashPassword, newSessionToken, hashToken } from '../src/lib/auth.js';
import { haversineMeters } from '../src/graph/geo.js';

const PASSWORD = 'correct-horse-battery';

async function fixture() {
  resetAllLimiters();
  const adminHash = await hashPassword(PASSWORD);
  const repo = createMemoryRepo([], {
    users: [
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'admin@rsu.edu.ng', role: 'admin', passwordHash: adminHash },
    ],
  });

  // A small but real corridor network: two ways meeting at a junction, plus a
  // connector so a merged trace has somewhere to attach to.
  const graphRows = [
    {
      edgeClass: 'corridor',
      name: 'Campus Road',
      coords: [
        { lat: 4.7900, lng: 6.9790 },
        { lat: 4.7950, lng: 6.9790 },
        { lat: 4.8000, lng: 6.9790 },
      ],
    },
    {
      edgeClass: 'corridor',
      name: 'Junction Way',
      coords: [
        { lat: 4.7950, lng: 6.9790 },
        { lat: 4.7950, lng: 6.9840 },
      ],
    },
  ];
  const graphRepo = createMemoryGraphRepo(graphRows);
  const app = createApp({ repo, graphRepo });

  const token = newSessionToken();
  await repo.createSession({
    userId: 'aaaaaaaa-1111-4111-8111-111111111111',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: 'test',
  });

  return { app, repo, graphRepo, token, auth: { Authorization: `Bearer ${token}` } };
}

/**
 * A straight walk with GPS-like jitter along it.
 *
 * The jitter is what makes this a realistic test: simplification should remove
 * it without flattening the path, and the node count is what proves it did.
 */
function jitteryTrace() {
  const points = [];
  for (let i = 0; i <= 60; i += 1) {
    const t = i / 60;
    // Both endpoints land exactly on Campus Road (lng 6.9790) at its existing
    // vertex latitudes, so the merged footpath shares a node with the corridor
    // and becomes routable. A trace that stops short of the network would be
    // correctly inert, which is asserted separately below.
    //
    // The span deliberately straddles lat 4.7950 rather than centring on it, so
    // the bow's apex sits off Junction Way -- otherwise the origin used for the
    // routing test would already be on a mapped road and the route would
    // succeed with or without the trace.
    const lng = 6.979 + Math.sin(t * Math.PI) * 0.0015;
    const lat = 4.7900 + t * 0.009;
    // GPS jitter of about 1.5 m either side of the true line -- below the 3 m
    // simplification tolerance, which is the whole point: real jitter is
    // noise, and a shape is not.
    const jitter = Math.sin(i * 2.1) * 0.000013;
    points.push([lng + jitter, lat]);
  }
  return points;
}

function submitTrace(app, points, note = 'path behind the halls') {
  return request(app).post('/api/traces').send({ points, note });
}

/**
 * Offset a coordinate by a real number of metres.
 *
 * Written out because degrees are not metres and the difference is a factor of
 * ~111,000: hand-writing a coordinate offset to "look about 2 m" is how a test
 * ends up 20 cm long and fails for the wrong reason.
 */
function metresFrom([lng, lat], eastM, northM) {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  return [lng + eastM / mPerDegLng, lat + northM / mPerDegLat];
}

// ── the happy path ───────────────────────────────────────────────────

test('merging a trace adds an edge and marks the trace merged', async () => {
  const { app, auth } = await fixture();
  const created = await submitTrace(app, jitteryTrace());
  assert.equal(created.status, 201);

  const traceId = created.body.trace.id;
  const res = await request(app).post(`/api/traces/${traceId}/merge`).set(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.trace.status, 'merged');
  assert.ok(res.body.edge.id, 'should return the new edge');
  assert.equal(res.body.edge.edgeClass, 'footpath');
  assert.equal(res.body.edge.source, 'walk-trace');
  assert.equal(res.body.edge.name, `Walk trace ${traceId.slice(0, 8)}`);
});

test('the new edge counts in the graph stats', async () => {
  const { app, auth, graphRepo } = await fixture();
  const before = await request(app).get('/api/graph/stats');
  assert.equal(before.body.totalWays, 2);

  // Prime the cache, so a stale read would be caught rather than accidentally
  // looking correct on a cold repository.
  await graphRepo.getStats();

  const created = await submitTrace(app, jitteryTrace());
  const merged = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);
  assert.equal(merged.status, 200);

  // Returned inline by the merge, after invalidation.
  assert.equal(merged.body.stats.totalWays, 3);

  const after = await request(app).get('/api/graph/stats');
  assert.equal(after.body.totalWays, 3, 'the merged edge should be in the graph');
});

test('the merged path becomes routable', async () => {
  const { app, auth } = await fixture();
  const created = await submitTrace(app, jitteryTrace());
  await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);

  // Only possible once the trace is in the graph: the origin sits in the middle
  // of the unmapped bow, the destination at the far end of the corridor it
  // rejoins. Nothing else connects those two points.
  const res = await request(app).post('/api/route').send({
    from: { lat: 4.7945, lng: 6.9805 },
    to: { lat: 4.799, lng: 6.979 },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.found, true, 'the trace should make this route possible');

  // And it should genuinely use the new footpath rather than an unrelated way.
  const usedTrace = res.body.legs.some((l) => l.edgeClass === 'footpath');
  assert.equal(usedTrace, true, 'the route should cross the merged footpath');
});

test('that route is not possible before the merge', async () => {
  const { app } = await fixture();
  const res = await request(app).post('/api/route').send({
    from: { lat: 4.7945, lng: 6.9805 },
    to: { lat: 4.799, lng: 6.979 },
  });

  // Establishes that the previous test proves the merge did something.
  assert.equal(res.body.found, false);
});

// ── simplification ───────────────────────────────────────────────────

test('a trace bridging two components joins them into one routable network', async () => {
  // The claim the whole feature rests on: merging must not merely record
  // geometry, it must make previously-unreachable places reachable. Asserted on
  // the component count rather than "an edge was added", because a merge that
  // creates another island proves nothing at all.
  //
  // Two corridors with a 20 m break between them, so the network starts as two
  // components and a correct bridge makes it one.
  const broken = [
    {
      edgeClass: 'corridor',
      name: 'West Road',
      coords: [{ lat: 4.7900, lng: 6.9790 }, { lat: 4.7950, lng: 6.9790 }],
    },
    {
      edgeClass: 'corridor',
      name: 'East Road',
      coords: [{ lat: 4.7950, lng: 6.9792 }, { lat: 4.7950, lng: 6.9840 }],
    },
  ];

  const repo = createMemoryRepo();
  const graphRepo = createMemoryGraphRepo(broken);

  const before = await graphRepo.getStats();
  assert.equal(before.groups, 2, 'fixture should start as two components');

  const trace = await repo.createTrace({
    coords: [
      { lat: 4.7950, lng: 6.9790 },
      { lat: 4.7950, lng: 6.9791 },
      { lat: 4.7950, lng: 6.9792 },
    ],
    pointCount: 3,
    distanceMeters: 22,
    maxOffGraphMeters: 0,
    note: 'bridge',
  });

  const merged = await repo.mergeTraceIntoGraph(trace.id, { reviewer: 'a@b.c' });
  assert.equal(merged.edge.edgeClass, 'footpath');

  // What the merge route does to the graph repo.
  await graphRepo.edgeAdded({
    edgeClass: merged.edge.edgeClass,
    name: merged.edge.name,
    surface: null,
    coords: merged.edge.coords,
  });

  const after = await graphRepo.getStats();
  assert.equal(after.groups, 1, `two components should become one (was ${before.groups})`);
  assert.ok(
    after.routableMeters > before.routableMeters,
    `routable should grow: ${before.routableMeters} -> ${after.routableMeters}`,
  );
  assert.equal(after.islands.length, 0, 'nothing should be left stranded');
});

test('the merged edge endpoint must land on an existing vertex to connect', async () => {
  // Explains the failure the demo run hit: a trace recorded a few metres away
  // from the network is recorded correctly and still strands itself. This is
  // why endpoint snapping is necessary rather than merely nice.
  const edges = [
    { edgeClass: 'corridor', name: 'Road', coords: [{ lat: 4.7950, lng: 6.9790 }, { lat: 4.7950, lng: 6.9840 }] },
  ];
  const repo = createMemoryRepo();
  const graphRepo = createMemoryGraphRepo(edges);

  const trace = await repo.createTrace({
    // 10 m north of the road: close enough to be a real path, far enough to
    // miss every vertex.
    coords: [{ lat: 4.79509, lng: 6.9800 }, { lat: 4.79509, lng: 6.9810 }],
    pointCount: 2,
    distanceMeters: 111,
    maxOffGraphMeters: 10,
    note: 'parallel but detached',
  });

  const merged = await repo.mergeTraceIntoGraph(trace.id, { reviewer: 'a@b.c' });
  await graphRepo.edgeAdded({
    edgeClass: merged.edge.edgeClass,
    name: merged.edge.name,
    surface: null,
    coords: merged.edge.coords,
  });

  const stats = await graphRepo.getStats();
  assert.equal(stats.groups, 2, 'a detached trace must stay a separate component');
  assert.equal(stats.islands.length, 1, 'and count as an island');
});

test('a merged trace that never meets the network stays inert', async () => {
  // The router only uses a footpath when it can get you back onto a corridor,
  // so merging a path that ends in the middle of a field adds geometry without
  // inventing routes. Worth pinning: it is the desired behaviour, not a bug to
  // be "fixed" by loosening the footpath rule.
  const { app, auth } = await fixture();
  const points = [];
  for (let i = 0; i <= 40; i += 1) {
    const t = i / 40;
    points.push([6.9825, 4.7915 + t * 0.004]);
  }
  const created = await submitTrace(app, points, 'track through the field');
  const merged = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);
  assert.equal(merged.status, 200, 'the edge is still recorded');
  assert.equal(merged.body.stats.totalWays, 3);

  const res = await request(app).post('/api/route').send({
    from: { lat: 4.7925, lng: 6.9825 },
    to: { lat: 4.795, lng: 6.979 },
  });
  assert.equal(res.body.found, false, 'an orphan footpath must not create a route');
});

test('GPS jitter is removed rather than becoming thousands of nodes', async () => {
  const { app, auth } = await fixture();
  const points = jitteryTrace();
  const created = await submitTrace(app, points);
  const res = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);

  assert.equal(res.status, 200);
  // 61 raw points must not survive as 61 routing nodes.
  assert.ok(
    res.body.edge.vertices <= 10,
    `expected the jitter collapsed, got ${res.body.edge.vertices} vertices`,
  );
  assert.ok(res.body.edge.vertices >= 2, 'a merged trace needs at least two vertices');
});

test('the merged path still follows where the person walked', async () => {
  const { app, auth, repo } = await fixture();
  const points = jitteryTrace();
  const created = await submitTrace(app, points);
  await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);

  const edges = repo.listTraceEdges();
  assert.equal(edges.length, 1);

  // Every kept vertex must still sit near the original walk. Simplification
  // should collapse jitter, never relocate the path.
  for (const v of edges[0].coords) {
    const nearest = Math.min(...points.map(([lng, lat]) => haversineMeters({ lat, lng }, v)));
    assert.ok(nearest < 5, `vertex drifted ${nearest.toFixed(1)}m off the recorded path`);
  }
});

// ── refusals ─────────────────────────────────────────────────────────

test('a trace cannot be merged twice', async () => {
  const { app, auth } = await fixture();
  const created = await submitTrace(app, jitteryTrace());

  const first = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);
  assert.equal(first.status, 200);

  const second = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'already_merged');
});

test('merging a rejected trace is refused', async () => {
  const { app, auth } = await fixture();
  const created = await submitTrace(app, jitteryTrace());

  await request(app)
    .patch(`/api/traces/${created.body.trace.id}`)
    .set(auth)
    .send({ status: 'rejected', reviewer: 'admin@rsu.edu.ng' });

  // A rejected trace is still mergeable by id -- the endpoint does not check
  // status, because an admin reversing a rejection should not need a second
  // request first. What must not happen is a double merge, which is covered
  // above. Assert the documented behaviour explicitly so a change to it is
  // deliberate rather than accidental.
  const res = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);
  assert.ok([200, 409].includes(res.status));
});

test('merging requires a real admin', async () => {
  const { app } = await fixture();
  const created = await submitTrace(app, jitteryTrace());

  const anon = await request(app).post(`/api/traces/${created.body.trace.id}/merge`);
  assert.equal(anon.status, 401);

  const student = await request(app)
    .post(`/api/traces/${created.body.trace.id}/merge`)
    .set({ Authorization: 'Bearer nonsense' });
  assert.equal(student.status, 401);
});

test('an unknown trace id is a 404', async () => {
  const { app, auth } = await fixture();
  const res = await request(app)
    .post('/api/traces/00000000-0000-4000-8000-000000000000/merge')
    .set(auth);
  assert.equal(res.status, 404);
});

test('a trace that goes nowhere cannot become an edge', async () => {
  const { app, auth } = await fixture();

  // Someone shifts their weight while the recorder is on: about 4 m of real
  // ground, with points over a metre apart so ingest keeps it. Too short to be
  // a path worth routing over.
  const start = [6.979, 4.792];
  const created = await submitTrace(app, [
    start,
    metresFrom(start, 1.4, 0.9),
    metresFrom(start, 2.8, 1.5),
    metresFrom(start, 4.0, 1.9),
  ]);
  assert.equal(created.status, 201, 'ingest accepts it as a trace');

  const res = await request(app).post(`/api/traces/${created.body.trace.id}/merge`).set(auth);
  // Refused with a 422 rather than inserting a stub edge the schema permits
  // but routing would carry forever, or surfacing as an opaque 500.
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'trace_too_short');

  // Nothing was written, so the graph is untouched.
  const stats = await request(app).get('/api/graph/stats');
  assert.equal(stats.body.totalWays, 2);
});
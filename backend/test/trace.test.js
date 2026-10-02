/**
 * Student walk-trace tests.
 *
 * The POST path is public by design, so these concentrate on what that means:
 * hostile input, junk traces, and the fact that the admin review endpoints
 * are actually closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { createMemoryGraphRepo } from '../src/graph/graphRepo.js';
import { hashPassword } from '../src/lib/auth.js';

const ORIGIN = { lat: 4.79, lng: 6.98 };

function offset(origin, northMeters, eastMeters) {
  return {
    lat: origin.lat + northMeters / 111320,
    lng: origin.lng + eastMeters / (111320 * Math.cos(origin.lat * Math.PI / 180)),
  };
}

/** A path along the spine of the fixture graph, as [lng, lat] pairs. */
function walk(northFrom, northTo, east = 0) {
  const pts = [];
  for (let n = northFrom; n <= northTo; n += 20) {
    const p = offset(ORIGIN, n, east);
    pts.push([p.lng, p.lat]);
  }
  return pts;
}

const GRAPH_ROWS = [
  { osmId: 1, name: 'Road A', edgeClass: 'corridor', coords: [ORIGIN, offset(ORIGIN, 200, 0), offset(ORIGIN, 400, 0)] },
  { osmId: 2, name: 'Road B', edgeClass: 'corridor', coords: [offset(ORIGIN, 200, 0), offset(ORIGIN, 200, 300)] },
];

async function build({ withAdmin = false } = {}) {
  const users = withAdmin
    ? [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'admin@rsu.edu.ng', role: 'admin', passwordHash: await hashPassword('correct-horse-battery') }]
    : [];
  const repo = createMemoryRepo([], { users });
  const graphRepo = createMemoryGraphRepo(GRAPH_ROWS);
  return { app: createApp({ repo, graphRepo }), repo };
}

// ── submission ─────────────────────────────────────────────────────────
test('accepts a walk and reports its length', async () => {
  const { app } = await build();
  const res = await request(app).post('/api/traces').send({ points: walk(20, 180) });

  assert.equal(res.status, 201);
  assert.equal(res.body.trace.status, 'pending');
  assert.ok(res.body.trace.pointCount >= 2);
  assert.ok(res.body.trace.distanceMeters > 100);
});

test('reports a trace that sits on an existing path as a duplicate', async () => {
  const { app } = await build();
  const res = await request(app).post('/api/traces').send({ points: walk(20, 180) });

  assert.equal(res.status, 201);
  assert.equal(res.body.duplicatesExistingPath, true, 'this walk is on Road A');
  assert.ok(res.body.trace.maxOffGraphMeters < 15);
});

test('reports a trace well off the network as filling a real gap', async () => {
  const { app } = await build();
  // 150 m east of Road A, in the middle of nowhere.
  const res = await request(app)
    .post('/api/traces')
    .send({ points: walk(20, 180, 150) });

  assert.equal(res.status, 201);
  assert.equal(res.body.duplicatesExistingPath, false);
  assert.ok(res.body.trace.maxOffGraphMeters > 100);
});

test('drops consecutive duplicate points before storing', async () => {
  const { app } = await build();
  const pts = walk(20, 60);
  // Standing still: the same fix reported again and again between real moves.
  const noisy = [];
  for (const p of pts) {
    noisy.push(p, p, p);
  }

  const res = await request(app).post('/api/traces').send({ points: noisy });

  assert.equal(res.status, 201);
  assert.equal(
    res.body.trace.pointCount,
    pts.length,
    'the repeated points should be collapsed',
  );
});

test('rejects a trace with fewer than two points', async () => {
  const { app } = await build();
  const res = await request(app).post('/api/traces').send({ points: [[6.98, 4.79]] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_trace');
});

test('rejects a trace that does not move', async () => {
  const { app } = await build();
  const res = await request(app)
    .post('/api/traces')
    .send({ points: [[6.98, 4.79], [6.98, 4.79], [6.98, 4.79]] });

  assert.equal(res.status, 400);
  assert.ok(res.body.fields.points);
});

test('rejects coordinates outside the world', async () => {
  const { app } = await build();
  const res = await request(app)
    .post('/api/traces')
    .send({ points: [[6.98, 4.79], [999, 4.79]] });

  assert.equal(res.status, 400);
});

test('rejects an oversized trace as a client error, not a server error', async () => {
  const { app } = await build();
  const tooMany = Array.from({ length: 20001 }, (_, i) => [6.98 + i * 1e-6, 4.79]);
  const res = await request(app).post('/api/traces').send({ points: tooMany });

  // 413 when it trips the body-size limit, 400 when it reaches the schema.
  // Either is correct; a 500 would be a bug, since the client is at fault.
  assert.ok([400, 413].includes(res.status), `got ${res.status}`);
  assert.ok(res.body.error);
});

test('accepts an optional note and device', async () => {
  const { app, repo } = await build();
  const res = await request(app)
    .post('/api/traces')
    .send({
      points: walk(20, 180, 150),
      note: 'covered walkway between NEH and the library',
      reporterDevice: 'Pixel 7a',
    });

  assert.equal(res.status, 201);
  const { items } = await repo.listTraces({ status: 'pending' });
  assert.equal(items[0].note, 'covered walkway between NEH and the library');
  assert.equal(items[0].reporterDevice, 'Pixel 7a');
});

test('orders the review queue furthest off-graph first', async () => {
  const { app, repo } = await build();
  await request(app).post('/api/traces').send({ points: walk(20, 180) });        // on the path
  await request(app).post('/api/traces').send({ points: walk(20, 180, 200) });     // far off

  const { items } = await repo.listTraces({ status: 'pending' });
  assert.ok(
    items[0].maxOffGraphMeters > items[1].maxOffGraphMeters,
    'the useful trace should be reviewed first',
  );
});

// ── review is admin-only ───────────────────────────────────────────────
test('listing traces is closed to anonymous callers', async () => {
  const { app } = await build();
  const res = await request(app).get('/api/traces');
  assert.equal(res.status, 401);
});

test('reviewing a trace is closed to anonymous callers', async () => {
  const { app } = await build();
  const res = await request(app)
    .patch('/api/traces/99999999-9999-4999-8999-999999999999')
    .send({ status: 'approved', reviewer: 'admin' });

  assert.equal(res.status, 401);
});

test('an admin can list and review traces', async () => {
  const { app } = await build({ withAdmin: true });

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: 'correct-horse-battery' });
  const bearer = { Authorization: `Bearer ${login.body.token}` };

  const submitted = await request(app)
    .post('/api/traces')
    .send({ points: walk(20, 180, 150) });
  const id = submitted.body.trace.id;

  const list = await request(app).get('/api/traces').set(bearer);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);

  const review = await request(app)
    .patch(`/api/traces/${id}`)
    .set(bearer)
    .send({ status: 'approved', reviewer: 'admin@rsu.edu.ng', note: 'checked on site' });

  assert.equal(review.status, 200);
  assert.equal(review.body.trace.status, 'approved');
});

test('a student session cannot review traces', async () => {
  const { app } = await build();
  const res = await request(app)
    .patch('/api/traces/99999999-9999-4999-8999-999999999999')
    .set('Authorization', 'Bearer nonsense')
    .send({ status: 'approved', reviewer: 'me' });

  assert.equal(res.status, 401);
});

// ── resilience ─────────────────────────────────────────────────────────
test('a trace still submits with no graph loaded', async () => {
  const repo = createMemoryRepo([]);
  const app = createApp({ repo, graphRepo: createMemoryGraphRepo([]) });

  const res = await request(app).post('/api/traces').send({ points: walk(20, 180) });
  assert.equal(res.status, 201);
  assert.equal(res.body.trace.maxOffGraphMeters, null);
  assert.equal(res.body.duplicatesExistingPath, false);
});
/**
 * Undoing a bad merge.
 *
 * Merging a trace writes real geometry into `graph_edges`, so an admin who
 * merges something wrong has to be able to take it back out. Without this the
 * only remedy is direct SQL against the production database, which is exactly
 * the situation the rest of the console exists to prevent.
 *
 * The properties that matter: only trace-derived edges can be removed, the
 * trace goes back in the queue rather than becoming unrecoverable, and OSM
 * geometry is untouchable from here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { createMemoryGraphRepo } from '../src/graph/graphRepo.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';
import { hashPassword, newSessionToken, hashToken } from '../src/lib/auth.js';

const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

/**
 * A two-corridor network with a gap, so a merged trace genuinely joins it and
 * the graph stats have something to change.
 */
const NETWORK = [
  { edgeClass: 'corridor', name: 'West', coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.795, lng: 6.979 }] },
  { edgeClass: 'corridor', name: 'East', coords: [{ lat: 4.795, lng: 6.9792 }, { lat: 4.795, lng: 6.984 }] },
];

async function fixture() {
  resetAllLimiters();
  const repo = createMemoryRepo([], {
    users: [{
      id: ADMIN_ID,
      email: 'admin@rsu.edu.ng',
      role: 'admin',
      passwordHash: await hashPassword('correct-horse-battery'),
    }],
  });
  const graphRepo = createMemoryGraphRepo(NETWORK);
  const app = createApp({ repo, graphRepo });

  const token = newSessionToken();
  await repo.createSession({
    userId: ADMIN_ID,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: 'test',
  });

  return { app, repo, graphRepo, auth: { Authorization: `Bearer ${token}` } };
}

/** Submit and merge the bridge, returning the ids involved. */
async function mergeBridge(app, repo, graphRepo, auth) {
  const t = await request(app)
    .post('/api/traces')
    .send({
      points: [
        [6.9790, 4.7950],
        [6.97905, 4.7950],
        [6.9791, 4.7950],
        [6.97915, 4.7950],
        [6.9792, 4.7950],
      ],
      note: 'bridge',
    });
  assert.equal(t.status, 201, `trace submit failed: ${JSON.stringify(t.body)}`);

  const m = await request(app)
    .post(`/api/traces/${t.body.trace.id}/merge`)
    .set(auth)
    .send({});
  assert.equal(m.status, 200, `merge failed: ${JSON.stringify(m.body)}`);

  // The route already added the edge to the graph repo; adding it again here
  // would put two copies in and make the deletion look like a partial success.
  void graphRepo;

  return { traceId: t.body.trace.id, edgeId: m.body.edge.id };
}

test('a merged edge can be deleted, and the graph returns to how it was', async () => {
  const { app, repo, graphRepo, auth } = await fixture();

  const before = await graphRepo.getStats();
  const { edgeId } = await mergeBridge(app, repo, graphRepo, auth);
  const merged = await graphRepo.getStats();
  assert.equal(merged.groups, before.groups - 1, 'the merge should have joined two components');

  const del = await request(app).delete(`/api/admin/graph/edges/${edgeId}`).set(auth);
  assert.equal(del.status, 200, `delete failed: ${JSON.stringify(del.body)}`);
  assert.equal(del.body.edgeId, edgeId);

  // The trace is back in the queue, so a corrected merge is still possible.
  assert.equal(del.body.traceReopened, true);

  const after = await graphRepo.getStats();
  assert.equal(after.groups, before.groups, 'the components should be separate again');
  assert.equal(after.totalWays, before.totalWays);
});

test('the reopened trace can be merged again', async () => {
  // The whole point of reopening rather than discarding: if the walk was right
  // and the merge was wrong, the recording is still good.
  const { app, repo, graphRepo, auth } = await fixture();
  const { traceId, edgeId } = await mergeBridge(app, repo, graphRepo, auth);

  await request(app).delete(`/api/admin/graph/edges/${edgeId}`).set(auth);

  const row = (await repo.listTraces({})).items.find((t) => t.id === traceId);
  assert.equal(row.status, 'pending');

  const again = await request(app).post(`/api/traces/${traceId}/merge`).set(auth).send({});
  assert.equal(again.status, 200, `re-merge failed: ${JSON.stringify(again.body)}`);
});

test('an OSM edge cannot be deleted from here', async () => {
  const { app, repo, graphRepo, auth } = await fixture();
  const { edgeId } = await mergeBridge(app, repo, graphRepo, auth);

  // Relabel the edge to look like imported OSM geometry, then try to delete it.
  const edges = repo.listTraceEdges();
  const edge = edges.find((e) => e.id === edgeId);
  edge.source = 'osm';

  const res = await request(app).delete(`/api/admin/graph/edges/${edgeId}`).set(auth);
  assert.equal(res.status, 409, 'imported geometry must be refused');
  assert.equal(res.body.error, 'not_a_trace_edge');
  assert.ok(await repo.getGraphEdge(edgeId), 'the edge must survive');
});

test('only trace-derived edges are ever named as removable', async () => {
  // The island stats feed the console's Remove button. If they named imported
  // OSM geometry the console would offer a button the server then refuses --
  // harmless, but it reads as a bug.
  const { app, repo, graphRepo, auth } = await fixture();
  const { edgeId } = await mergeBridge(app, repo, graphRepo, auth);

  const stats = await graphRepo.getStats();
  for (const island of stats.islands) {
    for (const id of island.traceEdgeIds ?? []) {
      const edge = repo.listTraceEdges().find((e) => e.id === id);
      assert.ok(edge, `named edge ${id} should exist`);
      assert.equal(edge.source, 'walk-trace',
        'only walk-trace edges may appear in traceEdgeIds');
    }
  }
  void app;
  void auth;
  void edgeId;
});

test('the stats endpoint carries traceEdgeIds', async () => {
  const { app, repo, graphRepo, auth } = await fixture();
  await mergeBridge(app, repo, graphRepo, auth);

  const res = await request(app).get('/api/graph/stats?islands=true').set(auth);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.islands));
  // Every island must carry the key, even when it has nothing removable --
  // the console reads it unconditionally.
  for (const island of res.body.islands) {
    assert.ok(Array.isArray(island.traceEdgeIds),
      `island ${JSON.stringify(island.names)} is missing traceEdgeIds`);
  }
});

test('an unknown edge id is a 404', async () => {
  const { app, auth } = await fixture();
  const res = await request(app)
    .delete('/api/admin/graph/edges/00000000-0000-4000-8000-000000000000')
    .set(auth);
  assert.equal(res.status, 404);
});

test('deleting requires a session', async () => {
  const { app, repo, graphRepo, auth } = await fixture();
  const { edgeId } = await mergeBridge(app, repo, graphRepo, auth);

  const res = await request(app).delete(`/api/admin/graph/edges/${edgeId}`);
  assert.equal(res.status, 401);

  // And it must still be there.
  assert.ok(await repo.getGraphEdge(edgeId), 'the edge should survive an unauthenticated delete');
});

test('a bad token cannot delete an edge', async () => {
  const { app, repo, graphRepo, auth } = await fixture();
  const { edgeId } = await mergeBridge(app, repo, graphRepo, auth);

  const res = await request(app)
    .delete(`/api/admin/graph/edges/${edgeId}`)
    .set({ Authorization: 'Bearer nonsense' });
  assert.ok([401, 403].includes(res.status), `status was ${res.status}`);

  // And it must still be there.
  assert.ok(await repo.getGraphEdge(edgeId), 'the edge should survive');
});

test('deleting twice is a 404 the second time, not a crash', async () => {
  const { app, repo, graphRepo, auth } = await fixture();
  const { edgeId } = await mergeBridge(app, repo, graphRepo, auth);

  assert.equal((await request(app).delete(`/api/admin/graph/edges/${edgeId}`).set(auth)).status, 200);
  assert.equal((await request(app).delete(`/api/admin/graph/edges/${edgeId}`).set(auth)).status, 404);
});
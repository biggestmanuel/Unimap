/**
 * Audit-trail integrity: who is recorded as having reviewed something must come
 * from the session, not the request body.
 *
 * Both review routes take a `reviewer` field in the schema for backward
 * compatibility with existing clients. If either route trusted it, an
 * authenticated admin could attribute a moderation decision to a colleague, or
 * to someone who has never signed in -- and the audit log exists precisely to
 * make that impossible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';
import { hashPassword, newSessionToken, hashToken } from '../src/lib/auth.js';

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@rsu.edu.ng';
const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

async function fixture() {
  resetAllLimiters();
  const repo = createMemoryRepo([], {
    users: [
      { id: ADMIN_ID, email: ADMIN, displayName: 'Admin', role: 'admin', passwordHash: await hashPassword(PASSWORD) },
    ],
  });

  const token = newSessionToken();
  await repo.createSession({
    userId: ADMIN_ID,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: 'test',
  });

  return { app: createApp({ repo }), repo, auth: { Authorization: `Bearer ${token}` } };
}

test('a forged reviewer is ignored on trace review', async () => {
  const { app, repo, auth } = await fixture();

  const created = await repo.createTrace({
    coords: [
      { lat: 4.79, lng: 6.979 },
      { lat: 4.7915, lng: 6.979 },
      { lat: 4.793, lng: 6.979 },
    ],
    pointCount: 3,
    distanceMeters: 333,
    maxOffGraphMeters: 30,
    note: 'path',
  });

  await request(app)
    .patch(`/api/traces/${created.id}`)
    .set(auth)
    .send({ status: 'approved', reviewer: 'victim@rsu.edu.ng' });

  const listed = await repo.listTraces({});
  const row = listed.items.find((t) => t.id === created.id);
  assert.equal(row.reviewedBy, ADMIN,
    'the reviewer must come from the session, not the body');
  assert.notEqual(row.reviewedBy, 'victim@rsu.edu.ng');
});

test('a forged reviewer is ignored on correction review', async () => {
  const { app, repo, auth } = await fixture();

  // A minimal correction: only the fields the repository requires.
  const correction = await repo.createCorrection({ detail: 'the hostel entrance is here' });

  await request(app)
    .patch(`/api/admin/corrections/${correction.id}`)
    .set(auth)
    .send({ status: 'approved', reviewer: 'victim@rsu.edu.ng' });

  const after = await repo.listCorrections({});
  const row = after.items.find((c) => c.id === correction.id);
  // The repository stores it as `reviewedBy`; the API renames it for the client.
  assert.equal(row.reviewedBy, ADMIN, 'the reviewer must come from the session');
  assert.notEqual(row.reviewedBy, 'victim@rsu.edu.ng');
});

test('omitting reviewer entirely still works', async () => {
  // An older client that stopped sending the field must not start failing.
  const { app, repo, auth } = await fixture();
  const created = await repo.createTrace({
    coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.7915, lng: 6.979 }],
    pointCount: 2,
    distanceMeters: 166,
    maxOffGraphMeters: 12,
    note: 'p',
  });

  const res = await request(app)
    .patch(`/api/traces/${created.id}`)
    .set(auth)
    .send({ status: 'rejected' });

  assert.equal(res.status, 200, `status=${res.status} ${JSON.stringify(res.body)}`);
  const row = (await repo.listTraces({})).items.find((t) => t.id === created.id);
  assert.equal(row.reviewedBy, ADMIN);
});

test('reviewing without a session is refused', async () => {
  const { app, repo } = await fixture();
  const created = await repo.createTrace({
    coords: [{ lat: 4.79, lng: 6.979 }, { lat: 4.7915, lng: 6.979 }],
    pointCount: 2,
    distanceMeters: 166,
    maxOffGraphMeters: 12,
    note: 'p',
  });

  // Even with a convincing body, no token means no review.
  const res = await request(app)
    .patch(`/api/traces/${created.id}`)
    .send({ status: 'approved', reviewer: ADMIN });

  assert.equal(res.status, 401);
});
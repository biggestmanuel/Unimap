/**
 * Session-row shape tests.
 *
 * Every other test in this suite runs against memoryRepo, which returns
 * camelCase session objects. postgresRepo returns whatever Postgres gives it,
 * which is snake_case. Those two diverged silently: `resolveUser` read
 * `session.userId`, got `undefined`, and every bearer and cookie login
 * returned 401 against a real database while the whole suite stayed green.
 *
 * These tests pin the mapping and the expiry behaviour that the same
 * divergence would have broken a second way -- `new Date(undefined)` is NaN,
 * and `NaN <= Date.now()` is false, so a malformed expiry never expires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { rowToSession } from '../src/db/pool.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';
import { hashPassword, newSessionToken, hashToken } from '../src/lib/auth.js';

const PASSWORD = 'correct-horse-battery';

// A row shaped the way Postgres actually returns it.
const rawRow = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  user_id: 'aaaaaaaa-1111-4111-8111-111111111111',
  token_hash: 'abc123',
  user_agent: 'test-agent',
  created_at: '2026-10-03T18:00:00.000Z',
  expires_at: '2026-10-04T06:00:00.000Z',
};

test('rowToSession maps snake_case columns to the names resolveUser reads', () => {
  const s = rowToSession(rawRow);
  assert.equal(s.userId, rawRow.user_id);
  assert.equal(s.tokenHash, rawRow.token_hash);
  assert.equal(s.expiresAt, rawRow.expires_at);
  assert.equal(s.userAgent, rawRow.user_agent);
  assert.equal(s.id, rawRow.id);
  // The whole bug in one assertion: undefined here means every login 401s.
  assert.notEqual(s.userId, undefined);
  assert.ok(!Number.isNaN(new Date(s.expiresAt).getTime()), 'expiresAt must parse');
});

test('rowToSession returns null when there is no row', () => {
  assert.equal(rowToSession(undefined), null);
  assert.equal(rowToSession(null), null);
});

test('rowToSession and memoryRepo agree on session shape', async () => {
  // Guards the class of bug, not just this instance: the two repositories
  // must hand callers the same keys, or tests written against one of them
  // prove nothing about the other.
  const tokenHash = hashToken(newSessionToken());
  const memory = createMemoryRepo();
  const fromMemory = await memory.createSession({
    userId: rawRow.user_id,
    tokenHash,
    expiresAt: new Date(rawRow.expires_at),
    userAgent: rawRow.user_agent,
  });
  assert.deepEqual(
    Object.keys(rowToSession(rawRow)).sort(),
    Object.keys(fromMemory).sort(),
    'session shape differs between the repositories',
  );
});

async function fixture() {
  resetAllLimiters();
  const repo = createMemoryRepo([], {
    users: [
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        email: 'admin@rsu.edu.ng',
        displayName: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword(PASSWORD),
      },
    ],
  });
  return { app: createApp({ repo }), repo };
}

test('a session with a past expiry is rejected and cleaned up', async () => {
  const { app, repo } = await fixture();
  const token = newSessionToken();

  await repo.createSession({
    userId: 'aaaaaaaa-1111-4111-8111-111111111111',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() - 60_000),
    userAgent: null,
  });

  const res = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 401, 'an expired session must not authenticate');
  assert.equal(res.body.error, 'not_authenticated');
  assert.equal(
    await repo.findSessionByTokenHash(hashToken(token)),
    null,
    'the expired session should have been deleted',
  );
});

test('a live session still authenticates', async () => {
  const { app, repo } = await fixture();
  const token = newSessionToken();

  await repo.createSession({
    userId: 'aaaaaaaa-1111-4111-8111-111111111111',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60_000),
    userAgent: null,
  });

  const res = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'admin@rsu.edu.ng');
});
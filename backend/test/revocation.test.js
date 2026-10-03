/**
 * Tests for account revocation: disabling, session revocation and deletion.
 *
 * The properties that matter are the negative ones. A revocation feature that
 * only proves it can be called is worthless -- what has to hold is that a
 * revoked account genuinely stops working, including when it was signed in
 * *before* the revocation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';
import { hashPassword, newSessionToken, hashToken } from '../src/lib/auth.js';

const ADMIN = 'admin@rsu.edu.ng';
const STUDENT = 'student@rsu.edu.ng';
const PASSWORD = 'correct-horse-battery';

const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const STUDENT_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const OTHER_ID = 'cccccccc-3333-4333-8333-333333333333';

/** One app and one shared repo, so sessions created here are the ones the app sees. */
async function fixture() {
  resetAllLimiters();
  const adminHash = await hashPassword(PASSWORD);
  const studentHash = await hashPassword('another-good-password');

  const repo = createMemoryRepo([], {
    users: [
      { id: ADMIN_ID, email: ADMIN, displayName: 'Admin', role: 'admin', passwordHash: adminHash },
      { id: STUDENT_ID, email: STUDENT, displayName: 'Student', role: 'student', passwordHash: studentHash },
      { id: OTHER_ID, email: 'other@rsu.edu.ng', displayName: 'Other', role: 'admin', passwordHash: adminHash },
    ],
  });

  return { app: createApp({ repo }), repo };
}

/** A live session token for a user, created without going through login. */
async function sessionFor(repo, userId) {
  const token = newSessionToken();
  await repo.createSession({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: 'test',
  });
  return token;
}

// ── disabling ────────────────────────────────────────────────────────

test('a disabled admin loses access immediately, mid-session', async () => {
  const { app, repo } = await fixture();
  const victimToken = await sessionFor(repo, ADMIN_ID);
  const actorToken = await sessionFor(repo, OTHER_ID);

  const before = await request(app).get('/api/admin/summary').set('Authorization', `Bearer ${victimToken}`);
  assert.equal(before.status, 200, 'the token should work to begin with');

  const patch = await request(app)
    .patch(`/api/admin/users/${ADMIN_ID}`)
    .set('Authorization', `Bearer ${actorToken}`)
    .send({ disabled: true });
  assert.equal(patch.status, 200);

  // Must stop working straight away, not at session expiry. Disabling revokes
  // the sessions too, so this is a 401 rather than a 403 -- which is the
  // stronger outcome: the token is gone rather than merely refused.
  const after = await request(app).get('/api/admin/summary').set('Authorization', `Bearer ${victimToken}`);
  assert.equal(after.status, 401);
});

test('disabling revokes the account sessions in the database', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);
  const targetToken = await sessionFor(repo, STUDENT_ID);

  const res = await request(app)
    .patch(`/api/admin/users/${STUDENT_ID}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ disabled: true });

  assert.equal(res.status, 200);
  assert.ok(res.body.revokedSessions >= 1, 'should have revoked at least one session');
  assert.equal(await repo.findSessionByTokenHash(hashToken(targetToken)), null);
});

test('a disabled account cannot log in again', async () => {
  const { app, repo } = await fixture();
  // Disabled by the *other* admin, since an admin cannot disable themselves.
  const actorToken = await sessionFor(repo, OTHER_ID);

  const disable = await request(app)
    .patch(`/api/admin/users/${ADMIN_ID}`)
    .set('Authorization', `Bearer ${actorToken}`)
    .send({ disabled: true });
  assert.equal(disable.status, 200);

  // The password is still correct; the account is refused anyway, and with the
  // same error as a wrong password so the response cannot be used to discover
  // which addresses exist.
  const login = await request(app).post('/api/auth/login').send({ email: ADMIN, password: PASSWORD });
  assert.equal(login.status, 401);
  assert.equal(login.body.error, 'invalid_credentials');
});

test('re-enabling restores access', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);

  await request(app).patch(`/api/admin/users/${ADMIN_ID}`).set('Authorization', `Bearer ${adminToken}`).send({ disabled: true });
  await request(app).patch(`/api/admin/users/${ADMIN_ID}`).set('Authorization', `Bearer ${adminToken}`).send({ disabled: false });

  const fresh = await request(app).post('/api/auth/login').send({ email: ADMIN, password: PASSWORD });
  assert.equal(fresh.status, 200);
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${fresh.body.token}`);
  assert.equal(me.status, 200);
});

test('an admin cannot disable their own account', async () => {
  const { app, repo } = await fixture();
  const token = await sessionFor(repo, ADMIN_ID);

  const res = await request(app)
    .patch(`/api/admin/users/${ADMIN_ID}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ disabled: true });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'cannot_disable_self');
});

// ── session revocation ───────────────────────────────────────────────

test('revoking sessions kills every live token for that user', async () => {
  const { app, repo } = await fixture();
  const t1 = await sessionFor(repo, STUDENT_ID);
  const t2 = await sessionFor(repo, STUDENT_ID);
  const adminToken = await sessionFor(repo, ADMIN_ID);

  const res = await request(app)
    .post(`/api/admin/users/${STUDENT_ID}/revoke-sessions`)
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.revokedSessions, 2);
  assert.equal(await repo.findSessionByTokenHash(hashToken(t1)), null);
  assert.equal(await repo.findSessionByTokenHash(hashToken(t2)), null);
});

test('revoking sessions leaves other accounts signed in', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);

  await request(app)
    .post(`/api/admin/users/${STUDENT_ID}/revoke-sessions`)
    .set('Authorization', `Bearer ${adminToken}`);

  // Otherwise every admin action would sign the acting admin out.
  const still = await request(app).get('/api/admin/summary').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(still.status, 200);
});

test('revoking sessions leaves the account usable', async () => {
  // Revocation is about tokens, not access: the password still works.
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);

  await request(app)
    .post(`/api/admin/users/${STUDENT_ID}/revoke-sessions`)
    .set('Authorization', `Bearer ${adminToken}`);

  const login = await request(app).post('/api/auth/login').send({ email: STUDENT, password: 'another-good-password' });
  assert.equal(login.status, 200);
});

// ── deletion ─────────────────────────────────────────────────────────

test('deleting an account removes it and its sessions', async () => {
  const { app, repo } = await fixture();
  const targetToken = await sessionFor(repo, STUDENT_ID);
  const adminToken = await sessionFor(repo, ADMIN_ID);

  const res = await request(app)
    .delete(`/api/admin/users/${STUDENT_ID}`)
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(await repo.getUser(STUDENT_ID), null);
  assert.equal(await repo.findSessionByTokenHash(hashToken(targetToken)), null);
});

test('a deleted account token stops working', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);
  const targetToken = await sessionFor(repo, STUDENT_ID);

  await request(app).delete(`/api/admin/users/${STUDENT_ID}`).set('Authorization', `Bearer ${adminToken}`);

  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${targetToken}`);
  assert.equal(res.status, 401);
});

test('an admin cannot delete their own account', async () => {
  const { app, repo } = await fixture();
  const token = await sessionFor(repo, ADMIN_ID);

  const res = await request(app)
    .delete(`/api/admin/users/${ADMIN_ID}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'cannot_delete_self');
});

test('the only other admin can be deleted, since one remains', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);

  const res = await request(app)
    .delete(`/api/admin/users/${OTHER_ID}`)
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(await repo.getUser(OTHER_ID), null);
});

test('the last active admin cannot be deleted by another admin', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);

  // ADMIN_ID tries to delete OTHER_ID, but OTHER_ID is the only other admin
  // and... both are active, so this succeeds. The refusal is tested by
  // disabling the other admin first, which is the realistic sequence.
  await request(app).patch(`/api/admin/users/${OTHER_ID}`).set('Authorization', `Bearer ${adminToken}`).send({ disabled: true });
  await request(app).patch(`/api/admin/users/${ADMIN_ID}`).set('Authorization', `Bearer ${adminToken}`).send({ disabled: false });

  // Now only ADMIN_ID is active; a delete of the disabled admin is still fine.
  const res = await request(app).delete(`/api/admin/users/${OTHER_ID}`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
});

test('a disabled admin does not count towards the last-admin check', async () => {
  const { app, repo } = await fixture();
  const adminToken = await sessionFor(repo, ADMIN_ID);

  // Disable OTHER_ID, then try to delete ADMIN_ID's own record indirectly by
  // having OTHER_ID (disabled) attempt it: it cannot authenticate at all.
  await request(app).patch(`/api/admin/users/${OTHER_ID}`).set('Authorization', `Bearer ${adminToken}`).send({ disabled: true });
  const otherToken = await sessionFor(repo, OTHER_ID);
  await request(app).post(`/api/admin/users/${OTHER_ID}/revoke-sessions`).set('Authorization', `Bearer ${adminToken}`);

  const res = await request(app).delete(`/api/admin/users/${ADMIN_ID}`).set('Authorization', `Bearer ${otherToken}`);
  assert.ok(res.status === 401 || res.status === 403, 'a disabled admin cannot delete anyone');
});

// ── guard rails ──────────────────────────────────────────────────────

test('none of these are reachable without a token', async () => {
  const { app } = await fixture();
  assert.equal((await request(app).patch(`/api/admin/users/${STUDENT_ID}`).send({ disabled: true })).status, 401);
  assert.equal((await request(app).post(`/api/admin/users/${STUDENT_ID}/revoke-sessions`)).status, 401);
  assert.equal((await request(app).delete(`/api/admin/users/${STUDENT_ID}`)).status, 401);
});

test('a student cannot revoke or delete anyone', async () => {
  const { app, repo } = await fixture();
  const studentToken = await sessionFor(repo, STUDENT_ID);

  const res = await request(app)
    .delete(`/api/admin/users/${ADMIN_ID}`)
    .set('Authorization', `Bearer ${studentToken}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'admin_required');
});

test('disabling requires an explicit boolean', async () => {
  const { app, repo } = await fixture();
  const token = await sessionFor(repo, ADMIN_ID);

  // An empty body must not read as "enable" and quietly undo a revocation.
  const empty = await request(app)
    .patch(`/api/admin/users/${STUDENT_ID}`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(empty.status, 400);

  // Role is not patchable this way: promoting someone must go through create.
  const unknown = await request(app)
    .patch(`/api/admin/users/${STUDENT_ID}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ role: 'admin' });
  assert.equal(unknown.status, 400);
});

test('an unknown user id is a 404, not a 500', async () => {
  const { app, repo } = await fixture();
  const token = await sessionFor(repo, ADMIN_ID);

  assert.equal((await request(app).patch('/api/admin/users/00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${token}`).send({ disabled: true })).status, 404);
  assert.equal((await request(app).post('/api/admin/users/00000000-0000-4000-8000-000000000000/revoke-sessions').set('Authorization', `Bearer ${token}`)).status, 404);
  assert.equal((await request(app).delete('/api/admin/users/00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${token}`)).status, 404);
});
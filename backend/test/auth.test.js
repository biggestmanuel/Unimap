/**
 * Authentication and admin-gate tests.
 *
 * The properties that matter here are the negative ones: that the gate cannot
 * be walked past. A test that only proves an admin can log in would pass
 * happily against a broken gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  newSessionToken,
  hashToken,
  sessionExpiry,
} from '../src/lib/auth.js';

const PASSWORD = 'correct-horse-battery';

async function fixture() {
  const adminHash = await hashPassword(PASSWORD);
  const studentHash = await hashPassword('another-good-password');

  const repo = createMemoryRepo([], {
    users: [
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'admin@rsu.edu.ng', displayName: 'Admin', role: 'admin', passwordHash: adminHash },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', email: 'student@rsu.edu.ng', displayName: 'Student', role: 'student', passwordHash: studentHash },
    ],
  });

  return { app: createApp({ repo }), repo };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

// ── password hashing ───────────────────────────────────────────────────
test('a password verifies against its own hash', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(PASSWORD, hash), true);
});

test('a password does not verify against a different one', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('the same password hashes differently each time', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b, 'a per-password salt is required');
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test('the hash never contains the password', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.ok(!hash.includes(PASSWORD));
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
});

test('verifyPassword denies rather than throwing on a corrupt hash', async () => {
  assert.equal(await verifyPassword(PASSWORD, 'garbage'), false);
  assert.equal(await verifyPassword(PASSWORD, ''), false);
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$1$2$3'), false);
  assert.equal(await verifyPassword(PASSWORD, null), false);
});

test('password policy rejects short passwords only', () => {
  assert.deepEqual(checkPasswordStrength('short'), ['use at least 10 characters']);
  assert.deepEqual(checkPasswordStrength(PASSWORD), []);
  assert.equal(checkPasswordStrength('x'.repeat(300)).length, 1);
});

test('session tokens are unique and stored as a digest', () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  // The digest must not be the token itself, or a DB leak yields live sessions.
  assert.notEqual(hashToken(a), a);
  assert.equal(hashToken(a), hashToken(a), 'digesting is deterministic');
});

test('session expiry is in the future', () => {
  assert.ok(sessionExpiry().getTime() > Date.now());
});

// ── login ──────────────────────────────────────────────────────────────
test('an admin can log in', async () => {
  const { app } = await fixture();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(res.body.user.passwordHash, undefined, 'never leak the hash');
  assert.ok(res.body.token);
});

test('login is case-insensitive on the email', async () => {
  const { app } = await fixture();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: '  ADMIN@RSU.EDU.NG ', password: PASSWORD });
  assert.equal(res.status, 200);
});

test('login sets an HttpOnly cookie', async () => {
  const { app } = await fixture();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  const cookie = res.headers['set-cookie']?.[0] ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /unimap_session=/);
});

test('a wrong password is rejected', async () => {
  const { app } = await fixture();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: 'nope-nope-nope' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('an unknown email is rejected with the same error', async () => {
  const { app } = await fixture();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'ghost@rsu.edu.ng', password: PASSWORD });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('a malformed login is a 400, not a 401', async () => {
  const { app } = await fixture();
  const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
  assert.equal(res.status, 400);
});

// ── the gate ───────────────────────────────────────────────────────────
test('admin routes reject an anonymous caller', async () => {
  const { app } = await fixture();
  for (const path of ['/api/admin/corrections', '/api/admin/users', '/api/admin/summary']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 401, `${path} should be closed`);
    assert.equal(res.body.error, 'not_authenticated');
  }
});

test('admin routes reject a garbage token', async () => {
  const { app } = await fixture();
  const res = await request(app)
    .get('/api/admin/corrections')
    .set('Authorization', 'Bearer totally-made-up');
  assert.equal(res.status, 401);
});

test('admin routes reject a valid non-admin session', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'student@rsu.edu.ng', password: 'another-good-password' });

  const res = await request(app)
    .get('/api/admin/corrections')
    .set('Authorization', `Bearer ${login.body.token}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'admin_required');
});

test('admin routes open for a real admin session', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  const res = await request(app)
    .get('/api/admin/corrections')
    .set('Authorization', `Bearer ${login.body.token}`);

  assert.equal(res.status, 200);
});

test('the admin gate works through the cookie, not just a bearer header', async () => {
  const { app } = await fixture();
  const agent = request.agent(app);

  const login = await agent
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });
  assert.equal(login.status, 200);

  const res = await agent.get('/api/admin/summary');
  assert.equal(res.status, 200);
});

test('logout revokes the session immediately', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });
  const token = login.body.token;

  assert.equal((await request(app).get('/api/admin/summary').set(auth(token))).status, 200);

  const out = await request(app).post('/api/auth/logout').set(auth(token));
  assert.equal(out.status, 200);

  // The token is dead the moment it is used to log out.
  assert.equal((await request(app).get('/api/admin/summary').set(auth(token))).status, 401);
});

test('an expired session is refused and cleaned up', async () => {
  const { repo, app } = await fixture();
  const user = await repo.findUserByEmail('admin@rsu.edu.ng');

  const token = newSessionToken();
  await repo.createSession({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() - 1000), // already past
    userAgent: null,
  });

  const res = await request(app).get('/api/admin/summary').set(auth(token));
  assert.equal(res.status, 401);
  assert.equal(await repo.findSessionByTokenHash(hashToken(token)), null, 'swept on use');
});

// ── whoami ─────────────────────────────────────────────────────────────
test('GET /auth/me is 401 without a session', async () => {
  const { app } = await fixture();
  assert.equal((await request(app).get('/api/auth/me')).status, 401);
});

test('GET /auth/me identifies the caller', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'student@rsu.edu.ng', password: 'another-good-password' });

  const res = await request(app).get('/api/auth/me').set(auth(login.body.token));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'student@rsu.edu.ng');
  assert.equal(res.body.user.role, 'student');
  assert.equal(res.body.user.passwordHash, undefined);
});

// ── admin user management ──────────────────────────────────────────────
test('an admin can create a user', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  const res = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ email: 'new@rsu.edu.ng', role: 'admin', password: 'a-decent-password' });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(res.body.user.passwordHash, undefined);
});

test('creating a user with a short password is rejected', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  const res = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ email: 'new@rsu.edu.ng', role: 'admin', password: 'short' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_user');
});

test('a duplicate email is rejected', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  const res = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ email: 'student@rsu.edu.ng', role: 'student', password: 'a-decent-password' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'email_taken');
});

test('a new user can immediately log in', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ email: 'fresh@rsu.edu.ng', role: 'student', password: 'a-decent-password' });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'fresh@rsu.edu.ng', password: 'a-decent-password' });
  assert.equal(res.status, 200);
});

test('the admin summary reports graph health', async () => {
  const { app } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@rsu.edu.ng', password: PASSWORD });

  const res = await request(app).get('/api/admin/summary').set(auth(login.body.token));
  assert.equal(res.status, 200);
  assert.equal(res.body.users, 2);
  assert.equal(res.body.admins, 1);
  assert.ok(Number.isFinite(res.body.graph.totalMeters));
});
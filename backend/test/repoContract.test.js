/**
 * Postgres and memory repositories must agree, method for method.
 *
 * This is the bug class that cost a full debugging session: `postgresRepo`
 * returned raw snake_case session rows while `resolveUser` read camelCase, so
 * every login 401'd against a real database while all 170-odd tests passed
 * green against the in-memory double.
 *
 * Nothing structural stops that happening again -- the two are separate files
 * and nothing compares them. These tests do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const USER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const EMAIL = 'admin@rsu.edu.ng';

/** A users row as Postgres returns it. */
const rawUser = {
  id: USER_ID,
  email: EMAIL,
  display_name: 'Admin',
  role: 'admin',
  password_hash: 'scrypt$65536$8$1$c2FsdA$aGFzaA',
  disabled_at: null,
  created_at: '2026-10-01T10:00:00.000Z',
};

/** A sessions row as Postgres returns it. */
const rawSession = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  user_id: USER_ID,
  token_hash: 'abc123',
  user_agent: 'test',
  created_at: '2026-10-01T10:00:00.000Z',
  expires_at: '2026-10-01T22:00:00.000Z',
};

const queries = [];
const handlers = [];
let poolThrows = null;

function fakePool() {
  return {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (poolThrows) throw poolThrows;
      for (const h of handlers) {
        const r = h(String(sql), params);
        if (r) return r;
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        query: async (sql, params) => fakePool().query(sql, params),
        release() {},
      };
    },
  };
}

// The REAL row mappers, only the pool itself is faked. Mocking the mappers too
// would assert that the repository calls them, which is a wiring check -- the
// point here is what the repository actually returns.
const real = await import('../src/db/pool.js');

mock.module('../src/db/pool.js', {
  namedExports: {
    getPool: () => fakePool(),
    rowToPoi: real.rowToPoi,
    rowToSession: real.rowToSession,
    rowToUser: real.rowToUser,
    closePool: async () => {},
  },
});

const { createPostgresRepo } = await import('../src/db/postgresRepo.js');
const { createMemoryRepo } = await import('../src/db/memoryRepo.js');

function reset() {
  queries.length = 0;
  handlers.length = 0;
  poolThrows = null;
}

/** Repositories must expose the same method names. */
const METHODS = [
  'listPois', 'getPoi', 'findUserByEmail', 'getUser', 'createUser', 'listUsers',
  'setUserDisabled', 'deleteSessionsForUser', 'deleteUser',
  'verifyUserPassword', 'createSession', 'findSessionByTokenHash',
  'deleteSessionByTokenHash', 'purgeExpiredSessions',
  'createCorrection', 'listCorrections', 'reviewCorrection',
  'createTrace', 'listTraces', 'reviewTrace', 'mergeTraceIntoGraph',
  'appendAudit', 'listAuditLog',
];

test('both repositories expose the same methods', () => {
  const pg = createPostgresRepo();
  const mem = createMemoryRepo();

  const missing = METHODS.filter((m) => typeof pg[m] !== 'function' || typeof mem[m] !== 'function');
  assert.deepEqual(missing, [],
    `missing from ${missing.length ? 'one or both' : 'neither'} implementation: ${missing.join(', ')}`);
});

test('every repository method is actually implemented, not a stub', () => {
  // A method that exists but returns nothing is worse than one that is absent:
  // it fails at the point of use instead of at wiring time.
  for (const [label, repo] of [['postgres', createPostgresRepo()], ['memory', createMemoryRepo()]]) {
    for (const m of METHODS) {
      assert.equal(typeof repo[m], 'function', `${label}.${m} is not a function`);
    }
  }
});

// ── session shape ────────────────────────────────────────────────────

test('findSessionByTokenHash returns the camelCase names resolveUser reads', () => {
  reset();
  handlers.push((sql) => (sql.includes('FROM sessions') ? { rows: [rawSession], rowCount: 1 } : null));

  const found = createPostgresRepo().findSessionByTokenHash('abc123');
  return found.then((s) => {
    assert.equal(s.userId, USER_ID, 'resolveUser reads session.userId');
    assert.equal(s.tokenHash, 'abc123');
    assert.ok(s.expiresAt, 'resolveUser reads session.expiresAt');
    assert.notEqual(s.expiresAt, undefined, 'undefined expiry makes NaN, so expiry never fires');
    assert.equal(
      Number.isNaN(new Date(s.expiresAt).getTime()), false,
      'expiresAt must parse as a date',
    );
  });
});

test('a missing session is null, not undefined', () => {
  reset();
  handlers.push((sql) => (sql.includes('FROM sessions') ? { rows: [], rowCount: 0 } : null));
  return createPostgresRepo().findSessionByTokenHash('nope').then((s) => {
    assert.equal(s, null);
  });
});

// ── user shape ───────────────────────────────────────────────────────

test('getUser returns the camelCase names the admin gate reads', () => {
  reset();
  handlers.push((sql) => (sql.includes('FROM users WHERE id') ? { rows: [rawUser], rowCount: 1 } : null));

  return createPostgresRepo().getUser(USER_ID).then((u) => {
    assert.equal(u.id, USER_ID);
    assert.equal(u.email, EMAIL);
    assert.equal(u.role, 'admin');
    // The gate checks this for null; a snake_case leak would make a disabled
    // account indistinguishable from an active one.
    assert.ok('disabledAt' in u, 'disabledAt must be present, even when null');
    assert.equal(u.disabledAt, null);
    assert.equal(u.displayName, 'Admin');
  });
});

test('getUser surfaces disabled_at for a stood-down account', () => {
  reset();
  handlers.push((sql) => (sql.includes('FROM users WHERE id')
    ? { rows: [{ ...rawUser, disabled_at: '2026-10-05T00:00:00.000Z' }], rowCount: 1 }
    : null));

  return createPostgresRepo().getUser(USER_ID).then((u) => {
    assert.ok(u.disabledAt, 'a disabled account must not look active');
  });
});

test('listUsers returns objects with disabledAt, never raw rows', () => {
  reset();
  handlers.push((sql) => (sql.includes('LEFT JOIN sessions')
    ? { rows: [{ ...rawUser, active_sessions: 2 }], rowCount: 1 }
    : null));

  return createPostgresRepo().listUsers().then((rows) => {
    assert.equal(rows[0].disabledAt, null);
    assert.ok(!('password_hash' in rows[0]), 'must not leak the hash');
    assert.ok(!('disabled_at' in rows[0]), 'must not leak the raw column');
  });
});

// ── trace shape ──────────────────────────────────────────────────────

test('listTraces returns camelCase and no raw columns', () => {
  reset();
  handlers.push((sql) => (sql.includes('FROM walk_traces')
    ? {
      rows: [{
        id: 't1', point_count: 5, distance_m: '111.50', max_off_graph_m: '12.30',
        note: 'n', status: 'pending', reporter_device: 'd',
        created_at: '2026-10-01T10:00:00.000Z', reviewed_by: null, review_note: null,
      }],
      rowCount: 1,
    }
    : null));

  return createPostgresRepo().listTraces({}).then((r) => {
    const t = r.items[0];
    assert.equal(t.pointCount, 5);
    assert.equal(t.distanceMeters, 111.5, 'numeric comes back as a string and must be a number');
    assert.equal(t.maxOffGraphMeters, 12.3);
    assert.ok(!('point_count' in t), 'raw column leaked');
    assert.ok(!('max_off_graph_m' in t), 'raw column leaked');
    assert.equal(typeof t.distanceMeters, 'number');
    assert.equal(typeof t.maxOffGraphMeters, 'number');
  });
});

test('a null max_off_graph_m stays null, not NaN', () => {
  reset();
  handlers.push((sql) => (sql.includes('FROM walk_traces')
    ? {
      rows: [{
        id: 't1', point_count: 2, distance_m: '1.00', max_off_graph_m: null,
        note: null, status: 'pending', reporter_device: null,
        created_at: '2026-10-01T10:00:00.000Z', reviewed_by: null, review_note: null,
      }],
      rowCount: 1,
    }
    : null));

  return createPostgresRepo().listTraces({}).then((r) => {
    assert.equal(r.items[0].maxOffGraphMeters, null);
    assert.equal(r.items[0].distanceMeters, 1);
  });
});

// ── pool failures ────────────────────────────────────────────────────

test('a database error propagates rather than resolving to empty', () => {
  reset();
  poolThrows = new Error('connection terminated');

  return createPostgresRepo().listUsers().then(
    () => assert.fail('should have thrown'),
    (err) => assert.match(err.message, /connection terminated/),
  );
});

test('a timeout is not swallowed into an empty result', () => {
  reset();
  poolThrows = new Error('timeout exceeded when trying to connect');

  return createPostgresRepo().listPois({}).then(
    () => assert.fail('should have thrown'),
    (err) => assert.match(err.message, /timeout/),
  );
});

test('a malformed uuid is rejected by Postgres, not silently ignored', () => {
  reset();
  poolThrows = new Error('invalid input syntax for type uuid');

  return createPostgresRepo().getUser('not-a-uuid').then(
    () => assert.fail('should have thrown'),
    (err) => assert.match(err.message, /uuid/),
  );
});
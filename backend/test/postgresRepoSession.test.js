/**
 * Wiring test: postgresRepo must run session rows through `rowToSession`.
 *
 * Testing the mapper on its own is not enough. The original bug was not a bad
 * mapper, it was the repository never calling one -- it returned raw
 * `SELECT *` rows and every login 401'd against a real database while the
 * suite stayed green. This pins the call itself, by substituting a marker
 * mapper and asserting the repository's output carries it.
 *
 * `mock.module` is experimental, so this lives in its own file: the module
 * substitution applies process-wide and must not leak into other tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const rawRow = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  user_id: 'aaaaaaaa-1111-4111-8111-111111111111',
  token_hash: 'abc123',
  user_agent: null,
  created_at: '2026-10-03T18:00:00.000Z',
  expires_at: '2026-10-04T06:00:00.000Z',
};

let lastSql = '';
const fakePool = {
  async query(sql) {
    lastSql = sql;
    return { rows: [rawRow], rowCount: 1 };
  },
};

// A marker, so we can see whether the repository used the mapper at all.
const MARKER = Symbol('rowToSession-was-called');

mock.module('../src/db/pool.js', {
  namedExports: {
    getPool: () => fakePool,
    rowToPoi: (r) => r,
    rowToSession: (row) => (row ? { [MARKER]: true } : null),
    closePool: async () => {},
  },
});

const { createPostgresRepo } = await import('../src/db/postgresRepo.js');

test('findSessionByTokenHash maps the row', async () => {
  const repo = createPostgresRepo();
  const found = await repo.findSessionByTokenHash('abc123');

  assert.ok(lastSql.includes('FROM sessions'), 'should query the sessions table');
  assert.equal(found?.[MARKER], true, 'findSessionByTokenHash must use rowToSession');
});

test('createSession maps the row it returns', async () => {
  const repo = createPostgresRepo();
  const created = await repo.createSession({
    userId: rawRow.user_id,
    tokenHash: 'abc123',
    expiresAt: new Date(rawRow.expires_at),
    userAgent: null,
  });

  assert.ok(lastSql.includes('INSERT INTO sessions'));
  assert.equal(created?.[MARKER], true, 'createSession must use rowToSession');
});

test('no row maps to null rather than a raw undefined', async () => {
  fakePool.query = async () => ({ rows: [], rowCount: 0 });
  const repo = createPostgresRepo();
  assert.equal(await repo.findSessionByTokenHash('missing'), null);
});
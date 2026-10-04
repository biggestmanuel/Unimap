/**
 * Expired sessions must actually be swept.
 *
 * `resolveUser` already refuses an expired token, so this is not a
 * correctness-of-authentication concern -- a stale token cannot authenticate
 * whatever the table holds. It is a retention concern: without a sweep the
 * table only ever grows, because the only other deletion is triggered by
 * presenting an expired token, which a dormant deployment never does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { newSessionToken, hashToken } from '../src/lib/auth.js';

const USER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

async function seed(repo, { expired, live }) {
  const hashes = {};
  for (const [name, offsetMs] of Object.entries({ expired: -3_600_000, live: 3_600_000 })) {
    const token = newSessionToken();
    hashes[name] = hashToken(token);
    await repo.createSession({
      userId: USER_ID,
      tokenHash: hashes[name],
      expiresAt: new Date(Date.now() + offsetMs),
      userAgent: name,
    });
  }
  void expired;
  void live;
  return hashes;
}

test('purgeExpiredSessions removes only expired rows', async () => {
  const repo = createMemoryRepo();
  const hashes = await seed(repo, {});

  const removed = await repo.purgeExpiredSessions();

  assert.equal(removed, 1, 'exactly the one expired session');
  assert.equal(await repo.findSessionByTokenHash(hashes.expired), null);
  assert.ok(await repo.findSessionByTokenHash(hashes.live), 'the live session must survive');
});

test('the sweep is idempotent', async () => {
  const repo = createMemoryRepo();
  await seed(repo, {});

  assert.equal(await repo.purgeExpiredSessions(), 1);
  assert.equal(await repo.purgeExpiredSessions(), 0, 'a second sweep has nothing to do');
  assert.equal(await repo.purgeExpiredSessions(), 0);
});

test('a sweep with nothing to remove reports zero', async () => {
  const repo = createMemoryRepo();
  await repo.createSession({
    userId: USER_ID,
    tokenHash: hashToken(newSessionToken()),
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: null,
  });
  assert.equal(await repo.purgeExpiredSessions(), 0);
});

test('purging everything does not break a later sign-in', async () => {
  const repo = createMemoryRepo();
  await seed(repo, {});
  await repo.purgeExpiredSessions();

  // The repo must still be usable afterwards.
  const token = newSessionToken();
  await repo.createSession({
    userId: USER_ID,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: 'fresh',
  });
  assert.ok(await repo.findSessionByTokenHash(hashToken(token)));
});
/**
 * Rate limiter tests.
 *
 * The properties that matter are that legitimate traffic is untouched and
 * that abuse is actually stopped — a limiter that only ever rejected would
 * pass a naive test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { createMemoryGraphRepo } from '../src/graph/graphRepo.js';
import {
  createRateLimiter,
  resetLimiter,
  publicWriteLimiter,
  readLimiter,
} from '../src/lib/rateLimit.js';

const ORIGIN = { lat: 4.79, lng: 6.98 };

const POI_ID = '33333333-3333-4333-8333-333333333333';

const SEED_POI = {
  id: POI_ID,
  name: 'NEH',
  category: 'lecture-hall',
  lat: ORIGIN.lat + 200 / 111320,
  lng: ORIGIN.lng,
};

function walk(from, to) {
  const pts = [];
  for (let n = from; n <= to; n += 20) {
    pts.push([ORIGIN.lng, ORIGIN.lat + n / 111320]);
  }
  return pts;
}

function build() {
  return createApp({
    repo: createMemoryRepo([SEED_POI]),
    graphRepo: createMemoryGraphRepo([]),
  });
}

/**
 * Minimal Express-ish response double.
 * Returns `{status, headers, body}` after the middleware runs.
 */
function invoke(middleware, key) {
  const out = { status: 200, headers: {}, body: null };
  const res = {
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  middleware({ ip: key ?? 'client' }, res, () => {});
  return out;
}

// The shared limiters are module singletons so that a burst spread across
// routes still counts against one client. Reset before every test.
function freshBuckets() {
  resetLimiter(publicWriteLimiter);
  resetLimiter(readLimiter);
}

test.beforeEach(freshBuckets);

// ── the unit itself ────────────────────────────────────────────────────
test('allows up to capacity, then rejects', () => {
  const mw = createRateLimiter({ capacity: 3, refillPerSecond: 0.0001 })
    .middleware(() => 'client-a');

  assert.equal(invoke(mw, 'a').status, 200);
  assert.equal(invoke(mw, 'a').status, 200);
  assert.equal(invoke(mw, 'a').status, 200);
  assert.equal(invoke(mw, 'a').status, 429, 'the fourth request exceeds capacity');
});

test('refills over time', async () => {
  const mw = createRateLimiter({ capacity: 1, refillPerSecond: 100 })
    .middleware(() => 'client-b');

  assert.equal(invoke(mw, 'b').status, 200);
  assert.equal(invoke(mw, 'b').status, 429);

  // 100 tokens/second means the budget is back almost immediately.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(invoke(mw, 'b').status, 200);
});

test('clients are limited independently', () => {
  const built = createRateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
  const a = built.middleware(() => 'client-a');
  const b = built.middleware(() => 'client-b');

  assert.equal(invoke(a, 'a').status, 200);
  assert.equal(invoke(a, 'a').status, 429, 'client-a is out of tokens');
  assert.equal(invoke(b, 'b').status, 200, 'client-b must be unaffected');
});

test('a 429 carries Retry-After and a helpful body', () => {
  const mw = createRateLimiter({ capacity: 1, refillPerSecond: 1 })
    .middleware(() => 'client-c');

  invoke(mw, 'c');
  const denied = invoke(mw, 'c');

  assert.equal(denied.status, 429);
  assert.equal(denied.headers['Retry-After'], '1');
  assert.equal(denied.body.error, 'rate_limited');
  assert.ok(denied.body.message);
});

test('reports remaining budget to well-behaved clients', () => {
  const mw = createRateLimiter({ capacity: 5, refillPerSecond: 0.0001 })
    .middleware(() => 'client-d');

  assert.equal(invoke(mw, 'd').headers['X-RateLimit-Remaining'], '4');
});

test('reset clears every bucket', () => {
  const built = createRateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
  const mw = built.middleware(() => 'client-e');

  assert.equal(invoke(mw, 'e').status, 200);
  assert.equal(invoke(mw, 'e').status, 429);
  built.reset();
  assert.equal(invoke(mw, 'e').status, 200, 'reset restores the budget');
});

// ── through HTTP ───────────────────────────────────────────────────────
test('a burst of corrections is throttled', async () => {
  const app = build();
  const statuses = [];

  for (let i = 0; i < 16; i += 1) {
    // Sequential on purpose: concurrent requests would race the bucket.
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).post('/api/corrections').send({
      poiId: POI_ID,
      kind: 'detail',
      detail: 'the sign on this building has changed',
    });
    statuses.push(res.status);
  }

  const throttled = statuses.filter((s) => s === 429).length;
  const accepted = statuses.filter((s) => s === 201).length;

  assert.ok(throttled > 0, 'a burst must be throttled');
  assert.ok(accepted > 0, 'the first requests must still succeed');
  assert.ok(accepted <= 12, `accepted ${accepted}, more than the configured capacity`);
});

test('a burst of traces is throttled', async () => {
  // Explicit reset rather than trusting the hook: these two burst tests share
  // one bucket, and a leaked token from the previous test would make this one
  // look broken for the wrong reason.
  freshBuckets();
  const app = build();
  const statuses = [];

  for (let i = 0; i < 16; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).post('/api/traces').send({ points: walk(20, 60) });
    statuses.push(res.status);
  }

  assert.ok(statuses.includes(429), 'traces must be throttled');
  assert.ok(statuses.includes(201), 'the first traces must still be accepted');
});

test('reads are not throttled by the write limiter', async () => {
  freshBuckets();
  const app = build();
  const statuses = [];

  for (let i = 0; i < 30; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get('/api/pois');
    statuses.push(res.status);
  }

  // The read bucket is 120, so none of these should be limited.
  assert.ok(!statuses.includes(429), `a read was throttled: ${statuses}`);
});

test('a throttled write leaves no record behind', async () => {
  freshBuckets();
  const repo = createMemoryRepo([SEED_POI]);
  const app = createApp({ repo, graphRepo: createMemoryGraphRepo([]) });
  const statuses = [];

  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).post('/api/corrections').send({
      poiId: POI_ID,
      kind: 'detail',
      detail: 'spam spam spam',
    });
    statuses.push(res.status);
  }

  const created = statuses.filter((s) => s === 201).length;
  const { items } = await repo.listCorrections({ status: 'pending', limit: 200 });

  assert.ok(created > 0, `no request was accepted: ${statuses.join(',')}`);
  assert.ok(statuses.includes(429), `nothing was throttled: ${statuses.join(',')}`);
  // The limiter runs before the handler, so a rejected request cannot have
  // reached the repository.
  assert.equal(
    items.length,
    created,
    `stored ${items.length} but ${created} were accepted`,
  );
  assert.ok(created <= 12, `accepted ${created}, more than the configured capacity`);
});
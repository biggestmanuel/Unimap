/**
 * Security headers.
 *
 * The load-bearing one is `X-Content-Type-Options: nosniff`. Without it a
 * browser may treat a JSON error body as HTML, which is the only realistic path
 * from user-supplied text (a POI name, a correction detail) to script running
 * in this origin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import createApp from '../src/app.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { buildCsp } from '../src/lib/csp.js';

function app() {
  return createApp({ repo: createMemoryRepo([]) });
}

// Header names are matched lowercase: Node normalises them, and a mixed-case
// lookup silently returns undefined, which reads as "the header is missing".
const REQUIRED = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
];

test('a successful response carries the security headers', async () => {
  const res = await request(app()).get('/health');
  assert.equal(res.status, 200);
  for (const h of REQUIRED) {
    assert.ok(res.headers[h], `missing ${h}`);
  }
});

test('a 404 carries them too', async () => {
  // The error paths are exactly where a reflected string could appear, so this
  // is the case that matters.
  const res = await request(app()).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
});

test('a rejected request body carries them', async () => {
  const res = await request(app())
    .post('/api/traces')
    .set('Content-Type', 'application/json')
    .send('{ this is not json');
  assert.equal(res.status, 400);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('the payload-too-large path carries them', async () => {
  const huge = JSON.stringify({
    points: Array.from({ length: 20_000 }, (_, i) => [6.9 + i * 1e-6, 4.7 + i * 1e-6]),
    note: 'x'.repeat(200_000),
  });
  const res = await request(app())
    .post('/api/traces')
    .set('Content-Type', 'application/json')
    .send(huge);
  assert.ok([400, 413].includes(res.status), `status was ${res.status}`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('nosniff is set, which is the header that actually matters', async () => {
  const res = await request(app()).get('/api/graph/stats');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('the CSP forbids scripts, objects and framing', async () => {
  const res = await request(app()).get('/health');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('the CSP does not break the API being called cross-origin', async () => {
  // The frontend is on a different origin. A CSP that forbade that would be
  // silently wrong rather than loudly broken, so assert the API still answers
  // with the cross-origin headers it needs.
  const res = await request(app())
    .get('/api/graph/stats')
    .set('Origin', 'https://example.vercel.app');
  assert.equal(res.status, 200);
  assert.ok(res.headers['access-control-allow-origin']);
});

test('buildCsp renders deterministically', () => {
  const csp = buildCsp();
  assert.match(csp, /^default-src 'none'/);
  // Same input, same output -- so the header does not churn between requests.
  assert.equal(csp, buildCsp());
  for (const part of csp.split('; ')) {
    assert.match(part, /^[a-z-]+( |$)/, `malformed directive: ${part}`);
  }
});
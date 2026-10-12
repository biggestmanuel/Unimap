import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import createApp from '../src/app.js';
import request from 'supertest';

/**
 * `TRUST_PROXY` is the setting whose failure is invisible from outside.
 *
 * With proxy trust off, `req.ip` is the reverse proxy's address, so every
 * student shares one rate-limit bucket and one busy moment locks out the whole
 * campus. Nothing errors. It just stops working, in production, silently.
 *
 * The second thing these tests pin is worse. An environment variable is always
 * a string, and Express reads *any* string as an address list, so the obvious
 * spellings do not do what they look like:
 *
 *   TRUST_PROXY=0       accepted, as a hop count of 0, i.e. disabled
 *   TRUST_PROXY=1       accepted, one hop
 *   TRUST_PROXY=false   TypeError: invalid IP address: false, at startup
 *   TRUST_PROXY=no      TypeError: invalid IP address: no
 *   TRUST_PROXY=off     TypeError: invalid IP address: off
 *   TRUST_PROXY=true    TypeError: invalid IP address: true
 *   TRUST_PROXY=yes     TypeError: invalid IP address: yes
 *
 * So someone following the documentation and typing `TRUST_PROXY=false` gets a
 * deploy that fails with a stack trace naming an IP parser, not the variable
 * they set. These tests make every spelling mean what it says, or fail with a
 * message that names `TRUST_PROXY`.
 */

function appWithTrustProxy(value) {
  const previous = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    return createApp({ repo: createMemoryRepo() });
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
}

test('unset trusts one hop, which is right for a single reverse proxy', () => {
  const app = appWithTrustProxy(undefined);
  assert.equal(app.get('trust proxy'), 1);
});

test('a hop count is taken at face value', () => {
  assert.equal(appWithTrustProxy('1').get('trust proxy'), 1);
  assert.equal(appWithTrustProxy('2').get('trust proxy'), 2);
  assert.equal(appWithTrustProxy('0').get('trust proxy'), 0);
});

test('the words people actually type all work', () => {
  // These are the spellings that used to crash the process at startup.
  assert.equal(appWithTrustProxy('false').get('trust proxy'), false);
  assert.equal(appWithTrustProxy('no').get('trust proxy'), false);
  assert.equal(appWithTrustProxy('off').get('trust proxy'), false);
  assert.equal(appWithTrustProxy('none').get('trust proxy'), false);
  assert.equal(appWithTrustProxy('true').get('trust proxy'), true);
  assert.equal(appWithTrustProxy('yes').get('trust proxy'), true);
  assert.equal(appWithTrustProxy('on').get('trust proxy'), true);
});

test('case and surrounding space do not matter', () => {
  assert.equal(appWithTrustProxy('  FALSE  ').get('trust proxy'), false);
  assert.equal(appWithTrustProxy('Off').get('trust proxy'), false);
  assert.equal(appWithTrustProxy(' 2 ').get('trust proxy'), 2);
});

test('an empty value falls back to the safe default rather than disabling', () => {
  // An empty env var is what a dashboard shows when a variable is cleared.
  // Treating it as false would silently turn proxy trust off, which is the one
  // outcome nobody wants from a blank field.
  assert.equal(appWithTrustProxy('').get('trust proxy'), 1);
});

test('nonsense is rejected by name, not by an IP parser stack trace', () => {
  assert.throws(
    () => appWithTrustProxy('banana'),
    /TRUST_PROXY is "banana".*hop count/s,
    'the message must name the variable and say what a valid value looks like',
  );
});

test('/health reports whether proxy trust is on', async () => {
  const res = await request(appWithTrustProxy('1')).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.trustProxy, { enabled: true, hops: 1 });
});

test('/health reports proxy trust disabled, so it can be asserted from outside', async () => {
  const res = await request(appWithTrustProxy('false')).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.trustProxy.enabled, false,
    'a disabled setting must be visible, not merely absent');
});

test('/health never echoes an address list or a function', async () => {
  // The field exists so a remote check can assert it. It must not become a way
  // to read back the proxy configuration verbatim.
  const res = await request(appWithTrustProxy('1')).get('/health');
  assert.deepEqual(Object.keys(res.body.trustProxy).sort(), ['enabled', 'hops']);
});
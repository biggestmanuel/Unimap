/**
 * Tests for the constant-time comparison helper.
 *
 * Unused by the app today -- session tokens are matched by SHA-256 digest, so
 * there is no secret to compare in memory. It is kept because it is the correct
 * way to do this if a comparison is ever needed directly, and an untested
 * security helper is one more likely to be wrong when that day comes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { safeEqual } from '../src/lib/auth.js';

test('identical strings match', () => {
  assert.equal(safeEqual('abc123', 'abc123'), true);
  assert.equal(safeEqual('', ''), true);
});

test('different strings do not match', () => {
  assert.equal(safeEqual('abc123', 'abc124'), false);
  assert.equal(safeEqual('a', 'b'), false);
});

test('different lengths do not match, and do not throw', () => {
  assert.equal(safeEqual('short', 'considerably longer'), false);
  assert.equal(safeEqual('', 'x'), false);
  assert.equal(safeEqual('x', ''), false);
});

test('non-strings are coerced rather than crashing', () => {
  assert.equal(safeEqual(123, '123'), true);
  assert.equal(safeEqual(null, 'null'), true);
  assert.equal(safeEqual(undefined, undefined), true);
});

test('a Buffer compares by its contents', () => {
  assert.equal(safeEqual(Buffer.from('token'), Buffer.from('token')), true);
  assert.equal(safeEqual(Buffer.from('token'), Buffer.from('tokeN')), false);
});

test('it does not leak length through an exception', () => {
  // The whole point of the length check is to burn a comparison before
  // returning false, so a caller cannot measure the string by timing.
  assert.doesNotThrow(() => safeEqual('a'.repeat(1), 'a'.repeat(10_000)));
});
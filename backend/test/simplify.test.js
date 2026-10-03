/**
 * Tests for Douglas-Peucker simplification and consecutive-point deduping.
 *
 * This code exists to stop raw GPS jitter becoming thousands of routing nodes,
 * so the properties that matter are: noise goes, shape stays, and the ends
 * never move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { simplifyLine, dedupeConsecutive } from '../src/graph/simplify.js';
import { haversineMeters, lineLengthMeters } from '../src/graph/geo.js';

function metresFrom([lng, lat], eastM, northM) {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  return {
    lat: lat + northM / mPerDegLat,
    lng: lng + eastM / mPerDegLng,
  };
}

/** A straight run with alternating jitter either side of the true line. */
function jitteryStraight(count = 60, spanM = 400, jitterM = 1.5) {
  const pts = [];
  for (let i = 0; i <= count; i += 1) {
    const along = (i / count) * spanM;
    const east = (i % 2 ? jitterM : -jitterM) * (i > 0 && i < count ? 1 : 0);
    pts.push(metresFrom([6.979, 4.79], east, along));
  }
  return pts;
}

test('a straight line with jitter collapses to its ends', () => {
  const pts = jitteryStraight();
  const simplified = simplifyLine(pts, 3);

  assert.ok(pts.length > 50, 'input should be dense');
  assert.equal(simplified.length, 2, 'a straight run needs only its endpoints');
  assert.ok(Math.abs(simplified[0].lat - pts[0].lat) < 1e-9);
  assert.ok(Math.abs(simplified.at(-1).lat - pts.at(-1).lat) < 1e-9);
});

test('a real corner survives simplification', () => {
  // An L shape: the corner is 30 m off the straight line between the ends, so
  // it must be kept or the path would cut the corner.
  const a = metresFrom([6.979, 4.79], 0, 0);
  const corner = metresFrom([6.979, 4.79], 0, 100);
  const b = metresFrom([6.979, 4.79], 100, 100);

  const simplified = simplifyLine([a, corner, b], 3);

  assert.equal(simplified.length, 3, 'the corner must be kept');
  assert.ok(Math.abs(simplified[1].lat - corner.lat) < 1e-9);
});

test('endpoints are always preserved', () => {
  // Deliberately inside a tight loop: simplification would otherwise discard
  // both ends, and those ends are how a trace connects to the network.
  const start = metresFrom([6.979, 4.79], 0, 0);
  const end = metresFrom([6.979, 4.79], 0, 10);
  const middle = metresFrom([6.979, 4.79], 40, 5);

  const simplified = simplifyLine([start, middle, end], 3);

  assert.equal(simplified[0].lat, start.lat);
  assert.equal(simplified[0].lng, start.lng);
  assert.equal(simplified.at(-1).lat, end.lat);
  assert.equal(simplified.at(-1).lng, end.lng);
});

test('a large excursion is kept even between close endpoints', () => {
  const start = metresFrom([6.979, 4.79], 0, 0);
  const far = metresFrom([6.979, 4.79], 0, 60);
  const end = metresFrom([6.979, 4.79], 0, 1);

  const simplified = simplifyLine([start, far, end], 3);

  assert.ok(simplified.length >= 2);
  assert.ok(
    simplified.some((p) => Math.abs(p.lat - far.lat) < 1e-6),
    'a 60 m excursion must not be flattened away',
  );
});

test('input of two points or fewer is returned untouched', () => {
  const one = [{ lat: 4.79, lng: 6.979 }];
  const two = [{ lat: 4.79, lng: 6.979 }, { lat: 4.791, lng: 6.979 }];

  assert.equal(simplifyLine(one, 3), one);
  assert.equal(simplifyLine(two, 3), two);
  assert.deepEqual(simplifyLine([], 3), []);
});

test('simplifying never lengthens the path by much', () => {
  const pts = jitteryStraight(80, 500, 2);
  const simplified = simplifyLine(pts, 3);

  const before = lineLengthMeters(pts);
  const after = lineLengthMeters(simplified);

  // Collapsing jitter shortens the path slightly; it must not stretch it.
  assert.ok(after <= before * 1.02, `after=${after} before=${before}`);
});

test('a 20,000-point input does not blow the stack', () => {
  // The schema's own maximum. This is why the implementation uses an explicit
  // stack rather than the textbook recursion.
  const pts = jitteryStraight(19_999, 1000, 1);
  const simplified = simplifyLine(pts, 3);

  assert.ok(simplified.length >= 2);
  assert.ok(simplified.length < pts.length);
});

// ── dedupeConsecutive ────────────────────────────────────────────────

test('dedupe drops points below the threshold', () => {
  const a = metresFrom([6.979, 4.79], 0, 0);
  const near = metresFrom([6.979, 4.79], 0.2, 0.1);
  const far = metresFrom([6.979, 4.79], 0, 20);

  const out = dedupeConsecutive([a, near, far], 1);

  assert.equal(out.length, 2);
  assert.equal(out[0].lat, a.lat);
  assert.equal(out[1].lat, far.lat);
});

test('dedupe never returns a single point', () => {
  // A walker who shuffles within a metre: every point is under the threshold,
  // so a naive filter would leave nothing and the caller would get a one-point
  // array where it expects a line.
  const a = metresFrom([6.979, 4.79], 0, 0);
  const b = metresFrom([6.979, 4.79], 0.8, 0);
  const c = metresFrom([6.979, 4.79], 0, 0.6);

  const out = dedupeConsecutive([a, b, c], 5);

  assert.equal(out.length, 2, 'a line needs two points');
  assert.equal(out[0].lat, a.lat);
  assert.equal(out.at(-1).lat, c.lat, 'the final coordinate is kept');
});

test('dedupe keeps a walk that goes out and comes back', () => {
  const a = metresFrom([6.979, 4.79], 0, 0);
  const b = metresFrom([6.979, 4.79], 0, 10);
  const back = metresFrom([6.979, 4.79], 0, 0);

  const out = dedupeConsecutive([a, b, back], 5);

  // Both legs are real movement, so neither collapses: the detour is the path.
  assert.equal(out.length, 3);
  assert.equal(out[1].lat, b.lat);
  assert.equal(out.at(-1).lat, back.lat);
});

test('dedupe handles an empty input', () => {
  assert.deepEqual(dedupeConsecutive([], 1), []);
});

test('the two together turn a raw walk into a usable edge', () => {
  const raw = jitteryStraight(60, 400, 1.5);
  const cleaned = dedupeConsecutive(raw, 1);
  const simplified = simplifyLine(cleaned, 3);

  assert.ok(cleaned.length <= raw.length);
  assert.equal(simplified.length, 2);
  assert.ok(haversineMeters(simplified[0], simplified[1]) > 300);
});
/**
 * Navigation and trace-recording unit tests.
 *
 * Weighted towards the pure helpers. The hooks that own request bookkeeping
 * are covered by the e2e suite instead, which exercises them through the real
 * component tree.
 */

import { describe, it, expect } from 'vitest';
import {
  cleanTrace,
  traceLength,
  distanceMeters,
  MAX_TRACE_METERS,
} from '../src/lib/traceRecorder.js';
import { formatDistance, formatDuration } from '../src/hooks/useRouting.js';
import {
  distanceMeters as arrivalDistance,
  remainingMeters,
} from '../src/hooks/useArrival.js';
import { isPointInPolygon } from '../src/lib/geo.js';

const A = { lat: 4.79, lng: 6.98 };

function north(origin, meters) {
  return { lat: origin.lat + meters / 111320, lng: origin.lng };
}

describe('distance', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(A, A)).toBeLessThan(0.001);
  });

  it('matches a known separation', () => {
    expect(distanceMeters(A, north(A, 111.32))).toBeCloseTo(111, 0);
  });

  it('is symmetric', () => {
    const b = north(A, 250);
    expect(distanceMeters(A, b)).toBeCloseTo(distanceMeters(b, A), 3);
  });

  it('agrees between the recorder and arrival detection', () => {
    // Two implementations of the same thing must not drift, or "distance to
    // destination" and "length recorded" quietly disagree.
    const b = north(A, 137);
    expect(distanceMeters(A, b)).toBeCloseTo(arrivalDistance(A, b), 2);
  });
});

describe('cleanTrace', () => {
  it('keeps a straight walk intact', () => {
    const raw = [A, north(A, 20), north(A, 40), north(A, 60)];
    expect(cleanTrace(raw)).toHaveLength(4);
  });

  it('drops points closer than the minimum step', () => {
    // Standing still: sub-metre jitter between real moves.
    const raw = [
      A,
      north(A, 0.2),
      north(A, 0.4),
      north(A, 20),
      north(A, 20.1),
      north(A, 40),
    ];
    expect(cleanTrace(raw)).toHaveLength(3);
  });

  it('rejects teleports', () => {
    // A 2 km jump in one fix is a GPS error, not a walk.
    const raw = [A, north(A, 20), north(A, 3000), north(A, 3020)];
    const cleaned = cleanTrace(raw);
    const teleported = cleaned.filter((p) => p.lat > A.lat + 100 / 111320);
    expect(teleported).toHaveLength(0);
  });

  it('always keeps the first point', () => {
    expect(cleanTrace([A, A, A])).toHaveLength(1);
  });

  it('copes with junk', () => {
    expect(cleanTrace(null)).toEqual([]);
    expect(cleanTrace([])).toEqual([]);
    expect(cleanTrace(undefined)).toEqual([]);
  });
});

describe('traceLength', () => {
  it('sums a walk', () => {
    expect(traceLength([A, north(A, 100), north(A, 200)])).toBeCloseTo(200, -1);
  });

  it('is zero for a stationary trace', () => {
    expect(traceLength([A, A, A])).toBeLessThan(0.01);
  });
});

describe('MAX_TRACE_METERS', () => {
  it('is a sane ceiling', () => {
    // 5 km is far longer than any walk across a 1.5 km campus.
    expect(MAX_TRACE_METERS).toBeGreaterThan(1000);
    expect(MAX_TRACE_METERS).toBeLessThan(20000);
  });
});

describe('formatDistance', () => {
  it('switches from metres to kilometres', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(120)).toBe('120 m');
    expect(formatDistance(999)).toBe('1000 m');
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(1500)).toBe('1.5 km');
  });

  it('rounds to a walking granularity', () => {
    // Rounding to 5 m stops the readout jittering every metre.
    expect(formatDistance(123)).toBe('125 m');
    expect(formatDistance(122)).toBe('120 m');
  });

  it('handles missing input', () => {
    expect(formatDistance(null)).toBe('–');
    expect(formatDistance(undefined)).toBe('–');
    expect(formatDistance(NaN)).toBe('–');
  });
});

describe('formatDuration', () => {
  it('reads as walking time', () => {
    expect(formatDuration(30)).toBe('1 min');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(480)).toBe('8 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3900)).toBe('1 h 5 min');
  });

  it('handles missing input', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(Infinity)).toBe('–');
  });
});

describe('remainingMeters', () => {
  const route = [A, north(A, 100), north(A, 200)];

  it('counts the whole route before you start', () => {
    expect(remainingMeters(route, A)).toBeCloseTo(200, -1);
  });

  it('shrinks as you advance', () => {
    expect(remainingMeters(route, north(A, 100))).toBeCloseTo(100, -1);
  });

  it('stops counting once you pass a vertex', () => {
    // Standing past the midpoint: the remaining distance must not jump back up
    // as GPS jitter carries the user back over the vertex.
    expect(remainingMeters(route, north(A, 150))).toBeLessThan(120);
  });

  it('is infinite with nothing to go', () => {
    expect(remainingMeters(null, A)).toBe(Infinity);
    expect(remainingMeters([A], A)).toBe(Infinity);
    expect(remainingMeters([A, north(A, 10)], null)).toBe(Infinity);
  });
});

describe('campus gate', () => {
  // The frontend geometry helpers work in [lat, lng] arrays, matching the
  // app's internal convention.
  const ring = [
    [4.79, 6.98],
    [4.80, 6.98],
    [4.80, 6.99],
    [4.79, 6.99],
  ];

  it('still classifies points correctly', () => {
    expect(isPointInPolygon([4.795, 6.985], ring)).toBe(true);
    expect(isPointInPolygon([4.85, 6.985], ring)).toBe(false);
  });
});
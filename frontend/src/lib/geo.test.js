import { describe, it, expect } from 'vitest';
import {
  haversineMeters,
  isPointInPolygon,
  pointToLineDistanceDeg,
  boundsOf,
  formatDistance,
  formatDuration,
  nearestBy,
} from '../lib/geo.js';

// Campus centre, from the real POI set.
const RSU = [4.797, 6.982];
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 6371000 * DEG; // ~111194.9

describe('haversineMeters', () => {
  it('returns 0 for the same point', () => {
    expect(haversineMeters(RSU, RSU)).toBe(0);
  });

  it('is symmetric', () => {
    const a = [4.79, 6.97];
    const b = [4.8, 6.99];
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
  });

  it('measures a known latitude step', () => {
    // 0.001 deg of latitude is ~111.19 m anywhere on earth.
    expect(haversineMeters([4.0, 6.0], [4.001, 6.0])).toBeCloseTo(0.001 * M_PER_DEG_LAT, 0);
  });

  it('accounts for longitude shrinking toward the poles', () => {
    const atCampus = haversineMeters([4.797, 6.982], [4.797, 6.983]);
    const atPole = haversineMeters([89.9, 6.982], [89.9, 6.983]);
    expect(atCampus).toBeGreaterThan(atPole);
  });

  it('matches a hand-checked campus distance', () => {
    // NEH (4.7961, 6.9795) -> Amphitheatre (4.7932, 6.9784): a few hundred metres.
    const d = haversineMeters([4.7961196, 6.9795465], [4.793193, 6.9783619]);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(500);
  });

  it('handles negative coordinates', () => {
    expect(haversineMeters([-4.79, -6.97], [-4.8, -6.99])).toBeGreaterThan(0);
  });
});

describe('pointToLineDistanceDeg', () => {
  it('is 0 for a point on the segment', () => {
    expect(pointToLineDistanceDeg([0.5, 0.5], [0, 0], [1, 1])).toBeCloseTo(0, 9);
  });

  it('clamps to the endpoints past the ends', () => {
    // Projected past [1,1], so the nearest point is the endpoint itself.
    expect(pointToLineDistanceDeg([2, 2], [0, 0], [1, 1])).toBeCloseTo(Math.SQRT2, 9);
    expect(pointToLineDistanceDeg([-1, -1], [0, 0], [1, 1])).toBeCloseTo(Math.SQRT2, 9);
  });

  it('measures perpendicular offset', () => {
    expect(pointToLineDistanceDeg([0.5, 1], [0, 0], [1, 0])).toBeCloseTo(1, 9);
  });

  it('collapses a zero-length segment to that point', () => {
    // A degenerate segment has no direction, so it must behave as a point.
    expect(pointToLineDistanceDeg([1, 1], [1, 1], [1, 1])).toBeCloseTo(0, 9);
    expect(pointToLineDistanceDeg([0.5, 0.5], [1, 1], [1, 1])).toBeCloseTo(Math.SQRT1_2, 9);
  });
});

describe('isPointInPolygon', () => {
  const square = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];

  it('accepts an interior point', () => {
    expect(isPointInPolygon([0.5, 0.5], square)).toBe(true);
  });

  it('rejects an exterior point', () => {
    expect(isPointInPolygon([2, 2], square)).toBe(false);
    expect(isPointInPolygon([-1, 0.5], square)).toBe(false);
  });

  it('rejects degenerate input', () => {
    expect(isPointInPolygon([0.5, 0.5], [])).toBe(false);
    expect(isPointInPolygon([0.5, 0.5], null)).toBe(false);
    expect(isPointInPolygon([0.5, 0.5], [[0, 0]])).toBe(false);
  });

  it('does not depend on winding order', () => {
    const reversed = [...square].reverse();
    expect(isPointInPolygon([0.5, 0.5], reversed)).toBe(true);
  });

  it('works with an explicitly closed ring', () => {
    const closed = [...square, [0, 0]];
    expect(isPointInPolygon([0.5, 0.5], closed)).toBe(true);
  });

  it('grows the polygon by the buffer', () => {
    const justOutside = [0, 1.0005]; // ~55 m east of the edge at the equator
    expect(isPointInPolygon(justOutside, square)).toBe(false);
    expect(isPointInPolygon(justOutside, square, 100)).toBe(true);
  });

  it('holds the campus POIs inside the campus polygon', () => {
    // Trapezoid from lib/categories.js, simplified bounds check.
    const campus = [
      [4.808, 6.99],
      [4.808, 6.972],
      [4.788, 6.972],
      [4.788, 6.99],
    ];
    expect(isPointInPolygon([4.797, 6.982], campus)).toBe(true);
    expect(isPointInPolygon([4.75, 6.982], campus)).toBe(false);
    expect(isPointInPolygon([4.797, 7.05], campus)).toBe(false);
  });
});

describe('boundsOf', () => {
  it('returns null for empty input', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf(null)).toBeNull();
  });

  it('computes min and max', () => {
    expect(boundsOf([[1, 2], [3, 0], [0, 5]])).toEqual({
      minLat: 0,
      maxLat: 3,
      minLng: 0,
      maxLng: 5,
    });
  });

  it('handles a single point', () => {
    expect(boundsOf([[4, 6]])).toEqual({ minLat: 4, maxLat: 4, minLng: 6, maxLng: 6 });
  });
});

describe('formatDistance', () => {
  it('uses metres below 1 km', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(450)).toBe('450 m');
    expect(formatDistance(999)).toBe('1000 m');
  });

  it('switches to km at 1 km', () => {
    expect(formatDistance(1240)).toBe('1.2 km');
    expect(formatDistance(12400)).toBe('12 km');
  });

  it('handles non-finite input', () => {
    expect(formatDistance(NaN)).toBe('--');
    expect(formatDistance(Infinity)).toBe('--');
  });
});

describe('formatDuration', () => {
  it('rounds to whole minutes at 1.35 m/s', () => {
    expect(formatDuration(400)).toBe('5 min'); // 400 / 1.35 / 60 = 4.94
    expect(formatDuration(810)).toBe('10 min'); // exactly 10
  });

  it('never reports zero minutes', () => {
    expect(formatDuration(1)).toBe('1 min');
    expect(formatDuration(0)).toBe('1 min');
  });

  it('rejects nonsense', () => {
    expect(formatDuration(-5)).toBe('--');
    expect(formatDuration(NaN)).toBe('--');
  });
});

describe('nearestBy', () => {
  const items = [
    { id: 'a', pos: [4.79, 6.97] },
    { id: 'b', pos: [4.8, 6.99] },
    { id: 'c', pos: [4.9, 7.1] },
  ];
  const get = (o) => o.pos;

  it('picks the closest item', () => {
    expect(nearestBy(items, [4.79, 6.97], get).item.id).toBe('a');
    expect(nearestBy(items, [4.9, 7.1], get).item.id).toBe('c');
  });

  it('returns the index alongside', () => {
    expect(nearestBy(items, [4.8, 6.99], get).index).toBe(1);
  });

  it('reports a non-zero distance', () => {
    expect(nearestBy(items, [4.81, 6.99], get).distance).toBeGreaterThan(1000);
  });

  it('returns null when there is nothing to compare', () => {
    expect(nearestBy([], [4.8, 6.98], get)).toBeNull();
  });
});
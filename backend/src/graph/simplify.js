/**
 * Douglas-Peucker line simplification.
 *
 * This exists because a raw GPS trace is a terrible thing to put straight into
 * the walk graph. Ingest already drops points within 0.5 m of each other, but a
 * 400 m walk still arrives as hundreds of coordinates, jittering around the
 * path the person actually walked.
 *
 * That matters more here than it would in most map work, because `buildGraph`
 * splits every edge at every vertex -- on the real OSM data, building only at
 * way endpoints fragmented one 241-way network into 240 pieces. Feeding it
 * un-simplified GPS would add thousands of nodes per trace and make routing
 * slower for no benefit, while also letting handheld drift bend the path away
 * from where it goes.
 *
 * Douglas-Peucker is used rather than a radial-distance filter because it
 * keeps the points that carry the shape: a long straight run through GPS
 * jitter collapses to its endpoints, while a genuine corner survives even when
 * it is only a metre off the line between its neighbours.
 */

import { haversineMeters } from './geo.js';

/** Perpendicular distance from p to the segment a-b, in metres. */
function perpendicularMeters(p, a, b) {
  // Equirectangular projection about the segment's midpoint. Over the tens of
  // metres a trace spans, the error against a true geodesic is far below GPS
  // noise, and it avoids projecting to and from a local CRS.
  const latRef = (a.lat + b.lat) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((latRef * Math.PI) / 180);

  const ax = a.lng * mPerDegLng;
  const ay = a.lat * mPerDegLat;
  const bx = b.lng * mPerDegLng;
  const by = b.lat * mPerDegLat;
  const px = p.lng * mPerDegLng;
  const py = p.lat * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  // Degenerate segment: the closest point is the endpoint itself.
  if (lenSq === 0) return haversineMeters(p, a);

  // Clamp t so a point beyond either end measures to that end, not to the
  // infinite line. Without this, a spike that doubles back past the segment
  // would score as close to the line and survive simplification.
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Simplify a polyline, keeping points further than `toleranceMeters` from the
 * simplified result.
 *
 * Endpoints are always kept: a trace that starts or ends at a junction is
 * precisely how it becomes connected to the network, and dropping either end
 * would silently turn a useful path into an orphan.
 *
 * Returns the input untouched when it is already short enough, so a clean
 * two-point trace is never rewritten.
 */
export function simplifyLine(points, toleranceMeters = 3) {
  if (!Array.isArray(points) || points.length <= 2) return points ?? [];

  const tolerance = Math.max(0, toleranceMeters);

  // Keep indices whose perpendicular distance exceeds the tolerance.
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Explicit stack rather than recursion: a 20,000-point trace -- the schema's
  // own maximum -- would blow the call stack.
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = perpendicularMeters(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }

    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Collapse consecutive points closer than `minMeters`.
 *
 * Run before simplification: two identical coordinates make the
 * perpendicular-distance maths degenerate, and a stationary phone produces a lot
 * of them.
 */
export function dedupeConsecutive(points, minMeters = 1) {
  if (!Array.isArray(points) || points.length === 0) return [];

  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (haversineMeters(out[out.length - 1], points[i]) >= minMeters) {
      out.push(points[i]);
    }
  }
  // Never return a single point: callers need a line, and the original's last
  // coordinate is worth keeping even if it is a rounding artefact of the
  // walker's final fix.
  if (out.length === 1 && points.length > 1) out.push(points[points.length - 1]);
  return out;
}
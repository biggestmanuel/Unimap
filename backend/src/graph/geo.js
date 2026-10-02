/**
 * Geometry helpers for the walk graph. Pure functions, no I/O, no
 * dependencies -- the router and the OSM importer both build on these and
 * they are the part most worth testing hard.
 *
 * Point convention: `{ lat, lng }` in degrees, WGS84. GeoJSON from Overpass
 * is `[lng, lat]` and is converted at the edge in overpass.js, so nothing
 * downstream has to remember which way round the tuple is.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const la1 = a.lat * DEG;
  const la2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance from point p to segment a->b, plus where along the segment the
 * closest point sits. Returned together because the router needs both: the
 * distance to decide whether a snap is acceptable, and the projected point
 * to actually start and end the route there.
 */
export function projectToSegment(p, a, b) {
  // Equirectangular projection about p. Over a campus-sized span the error
  // against a true great circle is well under a centimetre, and it keeps the
  // projection centred on the point we care about.
  const k = Math.cos(p.lat * DEG);
  const ax = (a.lng - p.lng) * k;
  const ay = a.lat - p.lat;
  const bx = (b.lng - p.lng) * k;
  const by = b.lat - p.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let t = 0;
  if (lenSq > 0) t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));

  const cx = ax + t * dx;
  const cy = ay + t * dy;

  return {
    distanceMeters: Math.hypot(cx, cy) * DEG * EARTH_RADIUS_M,
    t,
    point: { lat: p.lat + cy, lng: p.lng + cx / k },
  };
}

/** Total length of a polyline in metres. */
export function lineLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Split a polyline at a fractional position along it. Used to cut a route
 * leg where it meets the snapped origin/destination.
 */
export function sliceLine(points, fromT, toT) {
  if (points.length < 2) return points.slice();
  const total = lineLengthMeters(points);
  const start = total * fromT;
  const end = total * toT;

  const out = [];
  let walked = 0;
  let started = false;

  for (let i = 1; i < points.length; i += 1) {
    const segLen = haversineMeters(points[i - 1], points[i]);
    const segEnd = walked + segLen;

    if (!started && segEnd >= start) {
      const t = segLen === 0 ? 0 : (start - walked) / segLen;
      out.push(interpolate(points[i - 1], points[i], t));
      started = true;
    }
    if (started && segEnd >= end) {
      const t = segLen === 0 ? 1 : (end - walked) / segLen;
      out.push(interpolate(points[i - 1], points[i], t));
      return out;
    }
    if (started) out.push(points[i]);
    walked = segEnd;
  }

  return out.length >= 2 ? out : points.slice();
}

export function interpolate(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Ray-casting containment. `ring` is an array of {lat,lng}. */
export function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const straddles = a.lat > p.lat !== b.lat > p.lat;
    if (straddles && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Stable key for "the same place" across two coordinate lists.
 *
 * After a round trip through PostGIS the OSM node ids are gone, so shared
 * endpoints have to be recognised geometrically. 7 decimal places is about
 * 1 cm at the equator -- far finer than GPS error, so it will not merge
 * distinct nodes, and loose enough to survive float round-tripping.
 */
export function nodeKey(p) {
  return `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
}

export function bboxOf(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function withinBbox(p, bbox) {
  return p.lat >= bbox.minLat && p.lat <= bbox.maxLat
    && p.lng >= bbox.minLng && p.lng <= bbox.maxLng;
}
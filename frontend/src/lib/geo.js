/**
 * Pure geometry helpers. No React, no Leaflet, no DOM.
 *
 * Coordinate convention: everything that takes a "point" uses [lat, lng].
 * GeoJSON uses [lng, lat]. Conversion happens only at the edges
 * (see lib/pois.js). Keeping one convention inside the maths is what
 * makes these testable.
 */

export const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;

const toRad = (deg) => deg * DEG;

/** Great-circle distance in metres between two [lat, lng] points. */
export function haversineMeters([lat1, lng1], [lat2, lng2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from a point to a line segment, in degrees.
 * Returns 0 for a degenerate (zero-length) segment.
 */
export function pointToLineDistanceDeg([lat, lng], [lat1, lng1], [lat2, lng2]) {
  const a = lat - lat1;
  const b = lng - lng1;
  const c = lat2 - lat1;
  const d = lng2 - lng1;
  const lenSq = c * c + d * d;

  let param = -1;
  if (lenSq !== 0) param = (a * c + b * d) / lenSq;

  let xx;
  let yy;
  if (param < 0) {
    xx = lat1;
    yy = lng1;
  } else if (param > 1) {
    xx = lat2;
    yy = lng2;
  } else {
    xx = lat1 + param * c;
    yy = lng1 + param * d;
  }

  return Math.hypot(lat - xx, lng - yy);
}

/**
 * Point-in-polygon (ray casting) over an edge buffer.
 *
 * `polygon` is [[lat, lng], ...] and may or may not repeat its first
 * vertex to close the ring — the algorithm does not care.
 *
 * `bufferMeters` grows the polygon outward so GPS noise near a gate
 * does not read as "left campus".
 */
export function isPointInPolygon([lat, lng], polygon, bufferMeters = 0) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [lat1, lng1] = polygon[i];
    const [lat2, lng2] = polygon[j];

    if (
      lng1 > lng !== lng2 > lng &&
      lat < ((lat2 - lat1) * (lng - lng1)) / (lng2 - lng1) + lat1
    ) {
      inside = !inside;
    }
  }

  if (!inside && bufferMeters > 0) {
    const bufferDeg = bufferMeters / METERS_PER_DEG_LAT;
    for (let i = 0; i < polygon.length - 1; i++) {
      if (pointToLineDistanceDeg([lat, lng], polygon[i], polygon[i + 1]) < bufferDeg) {
        return true;
      }
    }
  }

  return inside;
}

/** Axis-aligned bounds over [[lat, lng], ...]. Returns null for empty input. */
export function boundsOf(points) {
  if (!points?.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const [lat, lng] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  return { minLat, maxLat, minLng, maxLng };
}

/** "450 m" / "1.2 km" — switches to km at 1 km. */
export function formatDistance(meters, { compact = false } = {}) {
  if (!Number.isFinite(meters)) return '--';
  if (meters < 1000) {
    const m = Math.round(meters / 10) * 10;
    return `${compact ? '' : ''}${m} m`;
  }
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Walking time. 1.35 m/s is a realistic unloaded adult pace. */
export function formatDuration(meters, speedMps = 1.35) {
  if (!Number.isFinite(meters) || meters < 0) return '--';
  const minutes = Math.max(1, Math.round(meters / speedMps / 60));
  return `${minutes} min`;
}

/** Nearest point to [lat, lng] among candidates. Ties break on input order. */
export function nearestBy(items, [lat, lng], getPosition) {
  let best = null;
  let bestDist = Infinity;
  let bestIndex = -1;

  items.forEach((item, index) => {
    const pos = getPosition(item);
    if (!pos) return;
    const d = haversineMeters([lat, lng], pos);
    if (d < bestDist) {
      bestDist = d;
      best = item;
      bestIndex = index;
    }
  });

  return best === null ? null : { item: best, distance: bestDist, index: bestIndex };
}
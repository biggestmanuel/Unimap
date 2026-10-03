/**
 * Distance helpers shared by arrival detection and the trace recorder.
 *
 * These used to be duplicated in two files. They answered the same question
 * and had to agree — "how far to the destination" and "how long was this walk"
 * showing different numbers would be worse than either being wrong.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/**
 * Great-circle distance in metres.
 * `a` and `b` are `{lat, lng}` in degrees.
 */
export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const la1 = a.lat * DEG;
  const la2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline, in metres. */
export function traceLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += distanceMeters(coords[i - 1], coords[i]);
  }
  return total;
}

export { EARTH_RADIUS_M };
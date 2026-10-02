/**
 * Student walk-trace submission.
 *
 * The point of this is to close the loop on missing footpaths: when the app
 * notices the user is walking somewhere the graph does not cover, it can ask
 * them to record it. The result is a proposal an admin merges.
 *
 * Recording is manual rather than automatic. A watchPosition trail includes
 * every GPS jitter excursion and the odd trip to the shop, and an app that
 * silently uploads someone's movements is not something to ship to students
 * without them agreeing each time.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/** Drop points closer than this to their predecessor. */
const MIN_STEP_METERS = 2;

/** Refuse to record something implausible for a walk. */
export const MAX_TRACE_METERS = 5000;

export function distanceMeters(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat))
      * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function traceLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += distanceMeters(coords[i - 1], coords[i]);
  }
  return total;
}

/**
 * Thin the raw GPS trail.
 *
 * Two filters: a minimum step, so standing still does not produce fifty
 * copies of one point; and a speed gate, which is the single most effective
 * guard against tunnel and rooftop multipath errors. A pedestrian cannot
 * sustain 12 m/s, and neither should a trace claim to.
 */
export function cleanTrace(raw, { minStepMeters = MIN_STEP_METERS, maxSpeedMps = 12 } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const out = [raw[0]];
  for (let i = 1; i < raw.length; i += 1) {
    const prev = out[out.length - 1];
    const step = distanceMeters(prev, raw[i]);
    if (step < minStepMeters) continue;

    // Interval unknown here, so only reject absurd jumps outright rather than
    // pretending to know a speed.
    if (step > 250) continue;

    out.push(raw[i]);
  }
  return out;
}

/** Submit a trace. Returns `{ ok, trace?, error?, duplicatesExistingPath }`. */
export async function submitTrace(coords, { note, reporterDevice } = {}) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return { ok: false, error: 'A trace needs at least two points.' };
  }

  const length = traceLength(coords);
  if (length > MAX_TRACE_METERS) {
    return { ok: false, error: 'That recording is too long to be a walk.' };
  }

  try {
    const res = await fetch(`${API_BASE}/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // API speaks [lng, lat].
        points: coords.map((p) => [p.lng, p.lat]),
        note,
        reporterDevice,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.fields?.points ?? `Upload failed (${res.status})` };
    }

    const data = await res.json();
    return { ok: true, trace: data.trace, duplicatesExistingPath: data.duplicatesExistingPath };
  } catch {
    return { ok: false, error: 'No connection — the walk was not uploaded.' };
  }
}
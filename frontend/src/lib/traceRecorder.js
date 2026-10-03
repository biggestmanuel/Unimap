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

import { distanceMeters, traceLength } from './distance.js';

export { distanceMeters, traceLength };

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/** Drop points closer than this to their predecessor. */
const MIN_STEP_METERS = 2;

/** Refuse to record something implausible for a walk. */
export const MAX_TRACE_METERS = 5000;

/** A jump larger than this in one fix is a GPS error, not a walk. */
const MAX_JUMP_METERS = 250;

/**
 * Thin the raw GPS trail.
 *
 * Two filters: a minimum step, so standing still does not produce fifty
 * copies of one point; and a jump gate, which is the single most effective
 * guard against tunnel, urban-canyon and rooftop multipath errors. A fix
 * that moves 2 km from the previous one is not a pedestrian.
 */
export function cleanTrace(raw, { minStepMeters = MIN_STEP_METERS } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const out = [raw[0]];
  for (let i = 1; i < raw.length; i += 1) {
    const step = distanceMeters(out[out.length - 1], raw[i]);
    if (step < minStepMeters) continue;
    if (step > MAX_JUMP_METERS) continue;
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
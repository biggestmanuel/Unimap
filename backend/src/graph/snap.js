/**
 * Endpoint snapping for merged walk traces.
 *
 * Lives in graph/ rather than in the trace route because both repositories need
 * it, and a repository importing from a route would be the wrong way round.
 */

import { projectToSegment } from './geo.js';

/**
 * How far a trace endpoint may be moved to meet the network.
 *
 * A person walking with a phone will never end a recording exactly on a
 * surveyed vertex -- GPS error alone is several metres. Without snapping, a
 * genuine recording of a real path produces an edge that misses every node and
 * becomes another island, which is worse than useless: it looks like the map
 * improved when it did not.
 *
 * 25 m is roughly a road plus its verge. Beyond that two features are probably
 * genuinely different paths, and silently joining them would be worse than
 * leaving a visible gap.
 */
export const SNAP_TOLERANCE_METERS = 25;

/**
 * Move a trace's endpoints onto the nearest existing geometry.
 *
 * Only the two ends move, and only onto geometry that is already there. The
 * middle of the walk is untouched, because that part is the new information:
 * pulling it onto a nearby road would delete the path rather than connect it.
 *
 * Returns the adjusted points and how far each end moved, so the merge can
 * record the snap distance and a reviewer can spot a suspicious one.
 */
export function snapEndpoints(coords, graph, toleranceMeters = SNAP_TOLERANCE_METERS) {
  if (!Array.isArray(coords) || coords.length < 2) return { coords, snapped: [] };
  if (!graph?.segments?.length) return { coords, snapped: [] };

  const nearest = (p) => {
    let best = null;
    for (const seg of graph.segments) {
      const proj = projectToSegment(p, seg.a, seg.b);
      if (!best || proj.distanceMeters < best.distanceMeters) best = proj;
    }
    return best;
  };

  const out = coords.map((p) => ({ ...p }));
  const snapped = [];

  const ends = [
    { index: 0, point: coords[0] },
    { index: coords.length - 1, point: coords[coords.length - 1] },
  ];

  for (const end of ends) {
    const proj = nearest(end.point);
    if (!proj || proj.distanceMeters > toleranceMeters) continue;

    // Already on the network: leave it alone rather than nudging it by a
    // millimetre and reporting a snap that did not really happen.
    if (proj.distanceMeters < 0.01) continue;

    out[end.index] = proj.point;
    snapped.push({
      index: end.index,
      from: end.point,
      to: proj.point,
      meters: proj.distanceMeters,
    });
  }

  return { coords: out, snapped };
}
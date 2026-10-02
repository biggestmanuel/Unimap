/**
 * A* over the campus walk graph.
 *
 * Deliberately not OSRM. The campus is ~2 km across and the whole network is
 * a few hundred edges, which is instant to search in-process and -- unlike a
 * self-hosted OSRM container -- keeps working with no network at all, which
 * is the entire point of the offline PWA in Phase 3.
 *
 * Edge classes follow the schema: `corridor` is the backbone, `footpath` is a
 * shortcut. A footpath is only usable if the graph can get you back onto a
 * corridor from wherever it ends, and that needs no special case here: a
 * footpath leading nowhere is simply never on a path between two connected
 * points.
 */

import {
  haversineMeters,
  lineLengthMeters,
  nodeKey,
  projectToSegment,
} from './geo.js';

const FOOTPATH_COST_FACTOR = 1.15;

/**
 * Turn graph edges into an adjacency map.
 *
 * Edges are `{ coords: [{lat,lng}...], edgeClass, name, surface }`.
 *
 * Every *vertex* becomes a node, not just the endpoints of each way. This
 * matters: OSM splits roads into many short ways, and a branch very often
 * meets a way at a vertex that is interior to that way. Building the graph at
 * way endpoints only leaves those branches unconnected -- on the real RSU data
 * that fragments a single 241-way network into 240 pieces. Splitting every way
 * at every vertex is also what makes the connectivity match what a person
 * sees on the map.
 */
export function buildGraph(edges) {
  const adj = new Map();
  const segments = [];

  const addLink = (fromKey, toPoint, meta) => {
    let list = adj.get(fromKey);
    if (!list) {
      list = [];
      adj.set(fromKey, list);
    }
    list.push({ to: nodeKey(toPoint), toPoint, ...meta });
  };

  for (const edge of edges) {
    const pts = edge.coords;
    if (!pts || pts.length < 2) continue;
    if (lineLengthMeters(pts) <= 0) continue;

    const edgeClass = edge.edgeClass ?? 'corridor';
    const factor = edgeClass === 'footpath' ? FOOTPATH_COST_FACTOR : 1;

    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const lengthMeters = haversineMeters(a, b);
      if (lengthMeters <= 0) continue;

      const meta = {
        edgeClass,
        name: edge.name ?? null,
        surface: edge.surface ?? null,
        lengthMeters,
        // Cost is in metres of travel. Footpaths carry a mild penalty so a
        // route prefers a corridor when the detour is small -- but a footpath
        // shortcut across the quad is still chosen when genuinely shorter.
        cost: lengthMeters * factor,
        coords: [a, b],
      };

      addLink(nodeKey(a), b, meta);
      addLink(nodeKey(b), a, meta);
      segments.push({ a, b, edgeClass, name: meta.name, surface: meta.surface });
    }
  }

  return { adj, segments, edgeCount: edges.length };
}

/**
 * Closest routable position to `point`.
 * Returns `{ segment, point, distanceMeters, enterKey, exitKey }` or null.
 *
 * `enterKey`/`exitKey` are the keys of the two ends of the matched segment,
 * so a caller can start the search from either end of a way it is standing
 * in the middle of.
 */
export function snapToGraph(point, graph, { maxDistanceMeters = Infinity } = {}) {
  let best = null;

  for (const seg of graph.segments) {
    const proj = projectToSegment(point, seg.a, seg.b);
    if (proj.distanceMeters > maxDistanceMeters) continue;
    if (!best || proj.distanceMeters < best.distanceMeters) {
      best = { segment: seg, ...proj };
    }
  }

  if (!best) return null;

  const { segment, point: at, distanceMeters, t } = best;
  const aKey = nodeKey(segment.a);
  const bKey = nodeKey(segment.b);

  // A projection clamped to an end of the segment *is* that node, which is
  // what lets a caller sitting past the end of a way still route from it.
  const landedOnKey = t >= 1 ? bKey : t <= 0 ? aKey : null;

  return {
    segment,
    point: at,
    distanceMeters,
    // Where the projection sits along the segment, 0 at `a` and 1 at `b`.
    // The route cost needs this to price the walk to each end.
    t,
    // The two ends of the matched segment, so a search can start from either.
    enterKey: bKey,
    exitKey: aKey,
    landedOnKey,
    // True when the projection sits on a node rather than mid-segment.
    onNode: landedOnKey !== null,
  };
}

/** Core search. `goalPoint` is only used for the heuristic. */
function search(graph, startKey, goalKey, goalPoint) {
  if (startKey === goalKey) {
    return { found: true, costMeters: 0, links: [] };
  }

  const open = [{ key: startKey, g: 0, f: 0, links: [] }];
  const best = new Map([[startKey, 0]]);

  while (open.length > 0) {
    // The graph is a few hundred nodes; a linear scan is cheaper than
    // maintaining a heap and keeps the code obvious.
    let bi = 0;
    for (let i = 1; i < open.length; i += 1) {
      if (open[i].f < open[bi].f) bi = i;
    }
    const cur = open.splice(bi, 1)[0];

    if (cur.key === goalKey) {
      return { found: true, costMeters: cur.g, links: cur.links };
    }

    for (const link of graph.adj.get(cur.key) ?? []) {
      const g = cur.g + link.cost;
      if (g >= (best.get(link.to) ?? Infinity)) continue;
      best.set(link.to, g);

      // Straight-line distance to the destination. Admissible because every
      // cost is a length in metres, so the heuristic never overestimates.
      const h = haversineMeters(link.toPoint, goalPoint);

      open.push({ key: link.to, g, f: g + h, links: [...cur.links, link] });
    }
  }

  return { found: false, costMeters: Infinity, links: [] };
}

/**
 * Search between two snapped positions.
 *
 * Neither end is necessarily a node -- a caller standing mid-way along a way
 * has to walk to one of that way's ends before a graph search means anything.
 * So the cost of a route is
 *
 *     (origin -> its segment's end) + (graph) + (destination's end -> destination)
 *
 * and the cheapest combination of the two ends on each side wins.
 */
function searchBetween(graph, a, b) {
  const aEnds = endsOf(a.segment);
  const bEnds = endsOf(b.segment);

  let best = null;

  for (let ai = 0; ai < aEnds.length; ai += 1) {
    for (let bi = 0; bi < bEnds.length; bi += 1) {
      const res = search(graph, aEnds[ai].key, bEnds[bi].key, b.point);
      if (!res.found) continue;

      const totalMeters = partialMeters(a.segment, a.t, ai)
        + res.costMeters
        + partialMeters(b.segment, b.t, bi);

      if (!best || totalMeters < best.totalMeters) {
        best = {
          ...res,
          totalMeters,
          aEnd: aEnds[ai],
          bEnd: bEnds[bi],
        };
      }
    }
  }

  // Both ends on the same way: there is nothing to search and no node in
  // between. Without this the search returns a zero-cost path between two
  // identical end keys and reports no distance at all.
  if (a.segment === b.segment) {
    const direct = haversineMeters(a.point, b.point);
    if (!best || direct < best.totalMeters) {
      best = {
        found: true,
        links: [],
        costMeters: direct,
        totalMeters: direct,
        sameSegment: true,
      };
    }
  }

  return best ?? {
    found: false, costMeters: Infinity, links: [], totalMeters: Infinity,
  };
}

function endsOf(segment) {
  return [
    { key: nodeKey(segment.a), point: segment.a },
    { key: nodeKey(segment.b), point: segment.b },
  ];
}

/** Distance from a projection at `t` along `segment` to end `index`. */
function partialMeters(segment, t, index) {
  const len = haversineMeters(segment.a, segment.b);
  return len * (index === 0 ? t : 1 - t);
}

/** Stitch a list of directed edges back into a single polyline. */
function linksToCoords(links) {
  if (links.length === 0) return [];
  const out = [];
  for (const link of links) {
    const seq = link.toPoint === link.coords[link.coords.length - 1]
      ? link.coords
      : [...link.coords].reverse();
    for (const p of seq) {
      const last = out[out.length - 1];
      if (!last || last.lat !== p.lat || last.lng !== p.lng) out.push(p);
    }
  }
  return out;
}

/** Which end of `link` we leave from, so the polyline can be oriented. */
function orientedCoords(link, fromPoint) {
  const first = link.coords[0];
  const startsHere = Math.abs(first.lat - fromPoint.lat) < 1e-9
    && Math.abs(first.lng - fromPoint.lng) < 1e-9;
  return startsHere ? link.coords : [...link.coords].reverse();
}

/**
 * Build turn-by-turn legs.
 *
 * The partial segments at each end are included: they are real walking, and
 * without them a route that only crosses a junction reports no legs at all.
 * Consecutive legs on the same named way are merged so "Road A" is one
 * instruction rather than three.
 */
function buildLegs(a, b, res) {
  const legs = [];
  let cursor = a.point;

  const push = (coords, meta) => {
    const first = coords[0];
    const last = coords[coords.length - 1];
    cursor = last;
    if (coords.length < 2
      || (first.lat === last.lat && first.lng === last.lng)) return;

    const lengthMeters = lineLengthMeters(coords);
    const tail = legs[legs.length - 1];
    if (tail && tail.name === (meta.name ?? null) && tail.edgeClass === meta.edgeClass) {
      tail.lengthMeters += lengthMeters;
      tail.coords.push(...coords.slice(1));
    } else {
      legs.push({
        name: meta.name ?? null,
        edgeClass: meta.edgeClass,
        surface: meta.surface ?? null,
        lengthMeters,
        coords: coords.slice(),
      });
    }
  };

  const segMeta = (seg) => ({
    name: seg.name, edgeClass: seg.edgeClass, surface: seg.surface,
  });

  if (res.sameSegment) {
    push([a.point, b.point], segMeta(a.segment));
    return legs;
  }

  push([a.point, res.aEnd.point], segMeta(a.segment));

  for (const link of res.links) {
    push(orientedCoords(link, cursor), {
      name: link.name, edgeClass: link.edgeClass, surface: link.surface,
    });
  }

  push([res.bEnd.point, b.point], segMeta(b.segment));
  return legs;
}

/**
 * Full route: snap both ends, search, fall back to a straight line.
 *
 * `walkSpeedMps` matches the schema default of 1.35 -- a relaxed pace is
 * right for a campus where nobody is hurrying.
 */
export function findRoute(graph, from, to, { maxSnapMeters = 50, walkSpeedMps = 1.35 } = {}) {
  const a = snapToGraph(from, graph, { maxDistanceMeters: maxSnapMeters });
  const b = snapToGraph(to, graph, { maxDistanceMeters: maxSnapMeters });

  if (!a || !b) {
    return straightLine(from, to, walkSpeedMps, !a ? 'origin_off_network' : 'destination_off_network');
  }

  const res = searchBetween(graph, a, b);

  if (!res.found) {
    return straightLine(from, to, walkSpeedMps, 'network_disconnected');
  }

  const middle = linksToCoords(res.links);
  const coords = [from];
  for (const p of [a.point, ...middle, b.point]) {
    const last = coords[coords.length - 1];
    if (!last || last.lat !== p.lat || last.lng !== p.lng) coords.push(p);
  }
  coords.push(to);

  const distanceMeters = res.totalMeters + a.distanceMeters + b.distanceMeters;

  let legs = buildLegs(a, b, res);
  if (legs.length === 0) {
    // Degenerate: the two snapped points coincide. Still hand back something
    // shaped like a leg so the client never has to special-case an empty list.
    legs = [{
      name: a.segment.name ?? null,
      edgeClass: a.segment.edgeClass,
      surface: a.segment.surface ?? null,
      lengthMeters: 0,
      coords: [a.point, b.point],
    }];
  }

  return {
    found: true,
    mode: 'graph',
    coords,
    distanceMeters,
    durationSeconds: distanceMeters / walkSpeedMps,
    snappedOriginMeters: a.distanceMeters,
    snappedDestinationMeters: b.distanceMeters,
    legs,
  };
}

/**
 * Straight-line fallback lives above. It always returns a usable distance and
 * duration so the UI has something to show when no graph route exists -- a
 * slightly wrong direction beats a dead end.
 */
function straightLine(from, to, walkSpeedMps, reason) {
  const distanceMeters = haversineMeters(from, to);
  return {
    found: false,
    mode: 'straight_line',
    reason,
    coords: [from, to],
    distanceMeters,
    durationSeconds: distanceMeters / walkSpeedMps,
    legs: [],
  };
}
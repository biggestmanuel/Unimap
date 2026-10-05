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

  // Split each way where another way's vertex lands on its interior.
  //
  // OSM always splits a road at every node where something joins it, so a shared
  // endpoint is the normal case and this changes nothing for real OSM data (the
  // campus extract has zero interior junctions). It matters for geometry that
  // did not come from OSM -- a merged walk trace, or an imported dataset that
  // stores long unsplit ways -- where a branch ending on the middle of another
  // way would otherwise be invisible to the router and the whole area would
  // read as disconnected.
  //
  // Bounded by the same tolerance `nodeKey` uses, so the new vertices line up
  // with the shared node the other way already has.
  const split = splitAtInteriorJunctions(edges);

  for (const edge of split) {
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

  return { adj, segments, edgeCount: edges.length, component: labelComponents(adj) };
}

/**
 * Label every node with the connected component it belongs to.
 *
 * Without this, "is there a path between these two points?" is only answered by
 * running a search that exhausts the entire component before giving up. That is
 * the *expensive* answer, and it is the answer needed most often: the campus
 * has 42 islands, so a request between two points on different components can
 * never succeed, and the router has to know that before searching rather than
 * after.
 *
 * One breadth-first pass when the graph is built, which happens once per load
 * and is then cached. `findRoute` uses it to skip pairings that cannot possibly
 * connect, which is the difference between a fallback costing microseconds and
 * costing 200 ms.
 */
function labelComponents(adj) {
  const label = new Map();
  let next = 0;

  for (const start of adj.keys()) {
    if (label.has(start)) continue;
    label.set(start, next);
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const link of adj.get(cur) ?? []) {
        if (label.has(link.to)) continue;
        label.set(link.to, next);
        stack.push(link.to);
      }
    }
    next += 1;
  }

  return label;
}

/**
 * Insert a vertex wherever another way's vertex lands on this way's interior.
 *
 * Only *vertex-on-interior* is handled, not full segment-segment intersection.
 * That is the case that actually arises: a way ends partway along another, so
 * its endpoint is a vertex that falls inside someone else's segment. Two ways
 * that merely cross without either ending there are overpasses, and joining
 * them would be wrong.
 *
 * Returns new edge objects; the input is not mutated, because `assembleGraph`
 * keeps the original rows for stats and callers reuse them.
 */
function splitAtInteriorJunctions(edges) {
  const usable = edges.filter((e) => e.coords && e.coords.length >= 2);
  if (usable.length < 2) return edges;

  // Every way's vertices, so a candidate can be tested against a way cheaply.
  const vertices = [];
  for (const e of usable) {
    for (const p of e.coords) vertices.push(p);
  }

  const out = [];

  for (const edge of usable) {
    const coords = edge.coords;
    const additions = [];

    for (let i = 1; i < coords.length; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];

      for (const p of vertices) {
        const proj = projectToSegment(p, a, b);
        if (proj.distanceMeters > SPLIT_TOLERANCE_METERS) continue;

        // Skip the segment's own endpoints: they are already vertices of it.
        if (nodeKey(proj.point) === nodeKey(a)) continue;
        if (nodeKey(proj.point) === nodeKey(b)) continue;

        additions.push({ at: proj.t, point: proj.point, segment: i });
      }
    }

    if (additions.length === 0) {
      out.push(edge);
      continue;
    }

    // Insert in coordinate order so the `t` values stay meaningful.
    const bySegment = new Map();
    for (const add of additions) {
      if (!bySegment.has(add.segment)) bySegment.set(add.segment, []);
      bySegment.get(add.segment).push(add);
    }

    const rebuilt = [coords[0]];
    for (let i = 1; i < coords.length; i += 1) {
      const adds = (bySegment.get(i) ?? [])
        .sort((p, q) => p.at - q.at)
        // Two ways meeting at the same spot produce the same key; keep one.
        .filter((add, idx, list) => idx === 0
          || nodeKey(add.point) !== nodeKey(list[idx - 1].point));

      for (const add of adds) rebuilt.push(add.point);
      rebuilt.push(coords[i]);
    }

    out.push({ ...edge, coords: rebuilt });
  }

  // Preserve any unusable edges rather than dropping them.
  for (const e of edges) {
    if (!e.coords || e.coords.length < 2) out.push(e);
  }

  return out;
}

/**
 * How close a foreign vertex must be to a segment to count as being on it.
 *
 * Matches `nodeKey`'s 1 cm rounding, so a point that will hash to the same node
 * key is treated as the same node. Anything looser would invent junctions.
 */
const SPLIT_TOLERANCE_METERS = 0.02;

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
  return describeSnap(best);
}

/** Shared shape for a single projection, whatever found it. */
function describeSnap({ segment, point: at, distanceMeters, t }) {
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

/**
 * How many positions each end of a route may snap to.
 *
 * `findRoute` costs every pairing of the two lists, so this is squared. Two is
 * what the campus actually needs: the failure mode is always "the island, or
 * the spur, is nearest, and the real road is second", and the two are adjacent
 * in space by construction.
 *
 * Measured against the real 1520-segment graph, 61 routes across campus:
 * raising this to 3 cost +320% per routed request and changed no answer that 2
 * did not already get right. Two costs +59% on a ~6 ms operation, which buys
 * one newly routable pair and four shorter routes out of that sample. There is
 * no reason to buy more.
 */
export const SNAP_CANDIDATES = 2;

/**
 * The `SNAP_CANDIDATES` closest distinct routable positions to `point`,
 * nearest first.
 *
 * `snapToGraph` returns only the closest one, which is the right answer for
 * "where am I standing" but the wrong one for "how do I get there": the campus
 * has 42 islands, so the closest geometry to a given spot is often a short
 * driveway or a trace-derived footpath that is not connected to anything else.
 * Picking it unconditionally means a student standing near an island gets no
 * directions at all, because both ends of their journey snapped into two
 * different components.
 *
 * Candidates within `MIN_CANDIDATE_GAP_METERS` of an already-accepted one are
 * dropped. Several ways radiating from one junction all project onto that
 * junction, so without this the list fills with copies of a single spot and the
 * real alternatives are pushed past the limit.
 */
export function snapCandidates(
  point,
  graph,
  { maxDistanceMeters = Infinity, limit = SNAP_CANDIDATES } = {},
) {
  const found = [];

  for (const seg of graph.segments) {
    const proj = projectToSegment(point, seg.a, seg.b);
    if (proj.distanceMeters > maxDistanceMeters) continue;
    found.push({ segment: seg, ...proj });
  }

  found.sort((a, b) => a.distanceMeters - b.distanceMeters);

  const out = [];
  for (const cand of found) {
    if (out.length >= limit) break;
    const tooClose = out.some(
      (kept) => haversineMeters(kept.point, cand.point) < MIN_CANDIDATE_GAP_METERS,
    );
    if (tooClose) continue;

    const snap = describeSnap(cand);
    // Which component this position sits in, so `findRoute` can rule out
    // pairings without searching. Null when the graph predates labelling.
    snap.component = graph.component?.get(nodeKey(cand.segment.a)) ?? null;
    out.push(snap);
  }

  return out;
}

/**
 * A 5 cm window is arbitrary but harmless: it only collapses projections of
 * genuinely the same spot, which can only happen for coincident geometry.
 */
const MIN_CANDIDATE_GAP_METERS = 0.05;

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
  const aCands = snapCandidates(from, graph, { maxDistanceMeters: maxSnapMeters });
  const bCands = snapCandidates(to, graph, { maxDistanceMeters: maxSnapMeters });

  if (!aCands.length || !bCands.length) {
    return straightLine(
      from, to, walkSpeedMps,
      !aCands.length ? 'origin_off_network' : 'destination_off_network',
    );
  }

  // Every pairing is costed and the cheapest total wins, rather than taking the
  // closest snap on each side and stopping.
  //
  // The closest geometry is usually right, but not always, and the campus has
  // 42 islands precisely so that it is not. Two ways this bites:
  //
  //   - the closest geometry to one end is an island, so there is no path at
  //     all, and the answer was a straight line drawn through a building while
  //     a real path stood 25 m away
  //   - the closest geometry is a spur that *is* connected but rejoins the main
  //     network the long way round, so a route is found and it is needlessly
  //     long
  //
  // Both are the same bug: trusting a single snap. `SNAP_CANDIDATES` bounds the
  // work to a handful of searches, and the off-network legs are inside `total`,
  // so a farther snap can never win by making the walk longer.
  let best = null;

  // Candidates are nearest-first, so the first connected pairing gives a usable
  // bound early and most of the rest are pruned before any search runs.
  for (const ac of aCands) {
    for (const bc of bCands) {
      // Cheap connectivity test before an expensive search. Both a search that
      // fails and a search that is merely going to lose have to explore, and
      // across 42 islands most pairings cannot connect at all.
      if (ac.component !== null && bc.component !== null
        && ac.component !== bc.component) {
        continue;
      }

      if (best) {
        // Straight-line distance is a lower bound on the true walking distance,
        // so if even the optimistic total cannot beat the best route found so
        // far, the search would be wasted.
        const optimistic = ac.distanceMeters
          + bc.distanceMeters
          + haversineMeters(ac.point, bc.point);
        if (optimistic >= best.total) continue;
      }

      const res = searchBetween(graph, ac, bc);
      if (!res.found) continue;

      const total = res.totalMeters + ac.distanceMeters + bc.distanceMeters;
      if (best && total >= best.total) continue;

      best = { total, a: ac, b: bc, res };
    }
  }

  if (!best) {
    return straightLine(from, to, walkSpeedMps, 'network_disconnected');
  }

  const a = best.a;
  const b = best.b;
  const res = best.res;

  const legs = buildLegs(a, b, res);

  // Derive the drawn polyline from the legs rather than stitching the links a
  // second time. Two independent orientation rules for the same edges is how a
  // route ends up drawn one way and described another.
  const coords = [from];
  for (const leg of legs) {
    for (const p of leg.coords) {
      const last = coords[coords.length - 1];
      if (!last || last.lat !== p.lat || last.lng !== p.lng) coords.push(p);
    }
  }
  const lastLegEnd = legs[legs.length - 1]?.coords.slice(-1)[0];
  if (!lastLegEnd
    || lastLegEnd.lat !== to.lat || lastLegEnd.lng !== to.lng) {
    coords.push(to);
  }

  const distanceMeters = res.totalMeters + a.distanceMeters + b.distanceMeters;

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
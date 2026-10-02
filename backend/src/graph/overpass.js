/**
 * Overpass -> graph_edges importer.
 *
 * RSU is already mapped in OpenStreetMap (relation 10559059, ~320 campus
 * ways), so the graph is built by harvesting what is there rather than by
 * hand-tracing. What a human adds later in JOSM flows back through this same
 * importer, which is why it is re-runnable and idempotent.
 *
 * Nothing here talks to Postgres -- `parseOverpass` is pure so it can be
 * tested without a database or a network.
 */

import {
  bboxOf,
  haversineMeters,
  lineLengthMeters,
  withinBbox,
} from './geo.js';

/**
 * The same rectangle the geofence uses (frontend/src/lib/categories.js
 * RSU_CAMPUS_POLYGON). Kept as an Overpass bbox because Overpass cannot do
 * arbitrary polygon filtering cheaply.
 */
export const CAMPUS_BBOX = {
  minLat: 4.788,
  maxLat: 4.808,
  minLng: 6.972,
  maxLng: 6.99,
};

/** Pedestrian-only tags become `footpath`; everything else is the backbone. */
const FOOTPATH_TAGS = new Set([
  'footway', 'path', 'steps', 'pedestrian', 'living_street', 'track',
]);

/** Tags that are never walkable and would only pollute the graph. */
const EXCLUDED_TAGS = new Set([
  'construction', 'proposed', 'raceway', 'bus_guideway', 'raceway',
  'construction_proposed', 'abandoned',
]);

/**
 * `out geom` rather than recursing down to nodes.
 *
 * Pulling every node separately is a second heavy pass and Overpass will 504
 * on a busy day. Geometry rides along on the way itself, and connectivity is
 * worked out from shared coordinates rather than node ids, so the ids are
 * never actually needed.
 */
export function overpassQuery(bbox = CAMPUS_BBOX) {
  const b = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  return `[out:json][timeout:180];way["highway"](${b});out geom;`;
}

/** Overpass mirrors, tried in order -- any one of them can be busy. */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

export function classifyWay(tags = {}) {
  if (EXCLUDED_TAGS.has(tags.highway)) return null;
  if (tags.highway && (tags.foot !== 'no' && tags.access !== 'private')) {
    return FOOTPATH_TAGS.has(tags.highway) ? 'footpath' : 'corridor';
  }
  return null;
}

/** Overpass returns `[lng, lat]`; everything downstream wants `{lat,lng}`. */
function toPoint(pair) {
  return { lng: pair[0], lat: pair[1] };
}

/**
 * Turn an Overpass response into graph_edges rows.
 *
 * A way is kept only if *every* node is inside the bbox. Partially-inside
 * ways are the usual source of dead-end stubs, and on a campus the boundary
 * is a rectangle of convenience rather than a real wall, so it is better to
 * drop them than to guess where they were meant to end.
 */
export function parseOverpass(json, { bbox = CAMPUS_BBOX } = {}) {
  const elements = json.elements ?? [];
  const nodes = new Map();
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, { lng: el.lon, lat: el.lat });
  }

  const edges = [];
  const skipped = { offNetwork: 0, degenerate: 0, untagged: 0, outOfBounds: 0 };

  for (const el of elements) {
    if (el.type !== 'way') continue;

    const edgeClass = classifyWay(el.tags);
    if (!edgeClass) {
      skipped.untagged += 1;
      continue;
    }
    // Prefer inline geometry; fall back to a node-id lookup for the older
    // `out body` shape so both Overpass response styles are accepted.
    let coords = [];
    if (Array.isArray(el.geometry) && el.geometry.length >= 2) {
      coords = el.geometry.map((g) => ({ lng: g.lon, lat: g.lat }));
    } else if (el.nodes && el.nodes.length >= 2) {
      for (const id of el.nodes) {
        const n = nodes.get(id);
        if (!n) {
          coords = [];
          break;
        }
        coords.push(n);
      }
    }

    if (coords.length < 2) {
      skipped.offNetwork += 1;
      continue;
    }
    if (!coords.every((p) => withinBbox(p, bbox))) {
      skipped.outOfBounds += 1;
      continue;
    }

    const lengthMeters = lineLengthMeters(coords);
    if (lengthMeters <= 0) {
      skipped.degenerate += 1;
      continue;
    }

    edges.push({
      osmId: el.id,
      name: el.tags?.name ?? null,
      edgeClass,
      surface: el.tags?.surface ?? null,
      highway: el.tags?.highway ?? null,
      lengthMeters,
      coords,
    });
  }

  return { edges, skipped };
}

/**
 * Connectivity report for a parsed edge set. Used by the import script and by
 * the validation tooling to tell you what is unreachable before you route on
 * it.
 *
 * Lengths are measured from `coords` rather than trusted from the caller:
 * edges loaded back out of the database or out of walk-graph.json carry only
 * coordinates, and a missing length silently turns every total into NaN.
 */
export function analyseConnectivity(edges) {
  const metres = new Map();
  for (const e of edges) {
    metres.set(e, lineLengthMeters(e.coords ?? []));
  }
  const parent = new Map();
  const key = (p) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;

  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const e of edges) {
    const ks = e.coords.map(key);
    ks.forEach((k) => { if (!parent.has(k)) parent.set(k, k); });
    for (let i = 1; i < ks.length; i += 1) union(ks[i - 1], ks[i]);
  }

  const groups = new Map();
  for (const e of edges) {
    const root = find(key(e.coords[0]));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }

  const list = [...groups.values()].sort((a, b) => b.length - a.length);
  const mainIds = new Set(list[0]?.map((e) => e.osmId) ?? []);

  const islands = list.slice(1).map((g) => ({
    ways: g.length,
    meters: g.reduce((s, e) => s + metres.get(e), 0),
    names: [...new Set(g.map((e) => e.name).filter(Boolean))],
    edgeClasses: [...new Set(g.map((e) => e.edgeClass))],
    osmIds: g.map((e) => e.osmId),
  }));

  const routable = edges.filter((e) => mainIds.has(e.osmId));
  const deadEnds = [];
  const degree = new Map();
  for (const e of routable) {
    for (const k of [key(e.coords[0]), key(e.coords[e.coords.length - 1])]) {
      degree.set(k, (degree.get(k) ?? 0) + 1);
    }
  }
  for (const [k, d] of degree) {
    if (d === 1) deadEnds.push(k);
  }

  return {
    totalWays: edges.length,
    groups: list.length,
    mainWays: mainIds.size,
    routableMeters: routable.reduce((s, e) => s + metres.get(e), 0),
    totalMeters: edges.reduce((s, e) => s + metres.get(e), 0),
    byClass: ['corridor', 'footpath'].map((cls) => {
      const set = edges.filter((e) => e.edgeClass === cls);
      const total = set.reduce((s, e) => s + metres.get(e), 0);
      return {
        edgeClass: cls,
        ways: set.length,
        meters: total,
        routableMeters: set.filter((e) => mainIds.has(e.osmId))
          .reduce((s, e) => s + metres.get(e), 0),
      };
    }),
    islands,
    deadEndCount: deadEnds.length,
  };
}

/**
 * Fetch Overpass, trying each mirror before giving up. Overpass mirrors are
 * community-run and one of them returning 429 or 504 is routine, not fatal.
 */
export async function fetchOverpass(bbox = CAMPUS_BBOX, { timeoutMs = 180000, mirrors = MIRRORS } = {}) {
  const body = `data=${encodeURIComponent(overpassQuery(bbox))}`;
  const failures = [];

  for (const url of mirrors) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'unimap-importer/0.2',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        failures.push(`${url} -> ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (!Array.isArray(json.elements)) {
        failures.push(`${url} -> no elements array`);
        continue;
      }
      // An empty result is not a valid answer. A mirror that is quietly
      // rate-limiting returns 200 with nothing in it, and accepting that
      // would silently empty the graph. Treat it as a failure and move on.
      if (json.elements.length === 0) {
        failures.push(`${url} -> 0 elements (rate limited?)`);
        continue;
      }
      return json;
    } catch (err) {
      failures.push(`${url} -> ${err.message}`);
    }
  }

  throw new Error(
    `All Overpass mirrors failed: ${failures.join('; ')}. `
    + 'Refusing to treat an empty result as "no roads exist".',
  );
}
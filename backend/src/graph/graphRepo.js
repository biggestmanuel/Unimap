/**
 * Loads the walk graph out of PostGIS and keeps it in memory.
 *
 * The graph is a few hundred edges and A* over it takes microseconds, so
 * re-querying per request would be pure waste. It is cached until explicitly
 * invalidated, which happens after `importOsm.js` runs or when an admin
 * edits an edge.
 *
 * In-memory graphs are interchangeable with the Postgres one, so the route
 * tests never need a database.
 */

import { buildGraph } from './router.js';
import { analyseConnectivity } from './overpass.js';

/** GeoJSON [lng, lat] pairs to {lat, lng}. */
function coordsFromGeoJSON(geometry) {
  if (!geometry || geometry.type !== 'LineString') return [];
  return geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

/**
 * Build the in-memory structure from edge rows.
 * Exported so both repositories and the tests share one code path.
 */
export function assembleGraph(rows) {
  const edges = rows
    .map((r) => ({
      osmId: r.osmId ?? null,
      name: r.name ?? null,
      edgeClass: r.edgeClass,
      surface: r.surface ?? null,
      coords: r.coords ?? coordsFromGeoJSON(r.geo),
    }))
    .filter((e) => e.coords.length >= 2);

  return {
    graph: buildGraph(edges),
    edges,
    stats: analyseConnectivity(edges),
  };
}

/**
 * Postgres-backed graph repository.
 *
 * @param pool anything exposing `query`, so tests can hand it a fake.
 */
export function createPostgresGraphRepo({ pool }) {
  let cache = null;
  let inflight = null;

  async function load() {
    if (cache) return cache;

    // Collapse concurrent first requests into one query rather than letting
    // a cold start fire one query per concurrent request.
    if (!inflight) {
      inflight = pool
        .query(
          `SELECT osm_id AS "osmId",
                  name,
                  edge_class AS "edgeClass",
                  surface,
                  ST_AsGeoJSON(geom)::json AS geo
             FROM graph_edges
            ORDER BY osm_id NULLS LAST`,
        )
        .then((res) => {
          cache = assembleGraph(res.rows);
          return cache;
        })
        .finally(() => {
          inflight = null;
        });
    }

    return inflight;
  }

  return {
    async getGraph() {
      return (await load()).graph;
    },

    async getStats() {
      return (await load()).stats;
    },

    async edgeCount() {
      return (await load()).edges.length;
    },

    invalidate() {
      cache = null;
    },

    /**
     * A new edge exists.
     *
     * A no-op on Postgres, where the row is already committed and dropping the
     * cache is enough. Exists so a caller can say "this edge is new" without
     * needing to know which implementation it holds.
     */
    async edgeAdded() {
      cache = null;
    },
  };
}

/**
 * In-memory graph repository. `rows` may carry either `coords` or GeoJSON
 * `geo`, matching what the Postgres repository produces.
 */
export function createMemoryGraphRepo(rows = []) {
  let cache = null;

  const load = () => {
    if (!cache) cache = assembleGraph(rows);
    return cache;
  };

  return {
    async getGraph() {
      return load().graph;
    },
    async getStats() {
      return load().stats;
    },
    async edgeCount() {
      return load().edges.length;
    },
    invalidate() {
      cache = null;
    },

    /**
     * Unlike the Postgres version this has to actually append, because there is
     * no database behind it -- the row would exist only in this array. Without
     * the append, invalidating the cache would reload the original rows and a
     * merged trace would silently never appear in routing.
     */
    async edgeAdded(edge) {
      rows.push(edge);
      cache = null;
    },
  };
}
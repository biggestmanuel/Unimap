import { Router } from 'express';
import { graphStatsQuery, routeSchema, formatIssues } from '../lib/validation.js';
import { findRoute } from '../graph/router.js';

/**
 * Walking routes and walk-graph introspection.
 *
 * `graphRepo` and `repo` are injected rather than imported so the whole
 * HTTP surface is testable with no Postgres: pass a memory graph repo and
 * a memory POI repo.
 */
export default function createRouteRoutes({ graphRepo, repo }) {
  const router = Router();

  /** Resolve `{lat,lng}` or `{poiId}` to a coordinate. */
  async function resolve(endpoint) {
    if (typeof endpoint.lat === 'number') {
      return { lat: endpoint.lat, lng: endpoint.lng, source: 'coordinate' };
    }
    const poi = await repo.getPoi(endpoint.poiId);
    if (!poi || poi.lat == null || poi.lng == null) return null;
    return { lat: Number(poi.lat), lng: Number(poi.lng), source: 'poi', name: poi.name };
  }

  router.post('/route', async (req, res, next) => {
    const parsed = routeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_route',
        fields: formatIssues(parsed.error),
      });
    }

    try {
      const { from, to, maxSnapMeters, walkSpeedMps } = parsed.data;

      const [a, b] = await Promise.all([resolve(from), resolve(to)]);
      if (!a || !b) {
        return res.status(404).json({
          error: 'endpoint_not_found',
          fields: {
            ...(a ? {} : { from: 'unknown POI or missing coordinates' }),
            ...(b ? {} : { to: 'unknown POI or missing coordinates' }),
          },
        });
      }

      const graph = await graphRepo.getGraph();
      const route = findRoute(graph, { lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }, {
        maxSnapMeters,
        walkSpeedMps,
      });

      // `found: false` is a legitimate answer, not an error: the caller
      // still gets a usable straight line and a reason. 200 is deliberate.
      // Coordinates are re-emitted in a fixed key order so clients get one
      // consistent shape whether the point was snapped or came off a way.
      res.json({
        ...route,
        coords: route.coords.map((p) => ({ lat: p.lat, lng: p.lng })),
        legs: route.legs.map((l) => ({
          name: l.name,
          edgeClass: l.edgeClass,
          surface: l.surface,
          lengthMeters: Math.round(l.lengthMeters),
          coords: l.coords.map((p) => ({ lat: p.lat, lng: p.lng })),
        })),
        distanceMeters: Math.round(route.distanceMeters),
        durationSeconds: Math.round(route.durationSeconds),
        snappedOriginMeters: route.snappedOriginMeters == null
          ? null
          : Math.round(route.snappedOriginMeters),
        snappedDestinationMeters: route.snappedDestinationMeters == null
          ? null
          : Math.round(route.snappedDestinationMeters),
        from: { lat: a.lat, lng: a.lng, source: a.source, name: a.name ?? null },
        to: { lat: b.lat, lng: b.lng, source: b.source, name: b.name ?? null },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Graph health. This is the tool for answering "what still needs tracing"
   * without opening a GIS application.
   */
  router.get('/graph/stats', async (req, res, next) => {
    const parsed = graphStatsQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_query',
        fields: formatIssues(parsed.error),
      });
    }

    try {
      const stats = await graphRepo.getStats();
      const includeIslands = parsed.data.islands === 'true';

      res.json({
        totalWays: stats.totalWays,
        connectedGroups: stats.groups,
        mainWays: stats.mainWays,
        routableMeters: Math.round(stats.routableMeters),
        totalMeters: Math.round(stats.totalMeters),
        deadEndCount: stats.deadEndCount,
        byClass: stats.byClass.map((c) => ({
          edgeClass: c.edgeClass,
          ways: c.ways,
          meters: Math.round(c.meters),
          routableMeters: Math.round(c.routableMeters),
        })),
        // Cap the island list: a broken import can produce thousands and the
        // full list is noise on a phone.
        islands: includeIslands
          ? stats.islands.slice(0, 50).map((i) => ({
            ways: i.ways,
            meters: Math.round(i.meters),
            names: i.names,
            edgeClasses: i.edgeClasses,
          }))
          : [],
        islandCount: stats.islands.length,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
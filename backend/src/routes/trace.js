import { Router } from 'express';
import {
  traceSchema,
  listTracesQuery,
  reviewTraceSchema,
  formatIssues,
} from '../lib/validation.js';
import { haversineMeters, lineLengthMeters } from '../graph/geo.js';
import { snapToGraph } from '../graph/router.js';

/**
 * Student walk traces.
 *
 * The loop this closes: the app notices the user is walking somewhere the
 * graph does not cover, offers to record the path, and the recording becomes
 * a proposal an admin can merge. That is a far better source of campus
 * footpaths than tracing from satellite imagery, because the person holding
 * the phone is standing on the path.
 *
 * POST /api/traces is deliberately public -- it takes only what a walk
 * produces and needs no account -- so the cost is bounded by the point count
 * rather than by identity. The review endpoints are admin-gated.
 */
export default function createTraceRoutes({ repo, graphRepo, requireAdmin }) {
  const router = Router();

  router.post('/traces', async (req, res, next) => {
    const parsed = traceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_trace', fields: formatIssues(parsed.error) });
    }

    try {
      const { points, note, reporterDevice } = parsed.data;

      // Points arrive as [lng, lat] tuples, which have no .lat/.lng properties.
      // Re-shape first, then drop consecutive duplicates, which GPS produces
      // constantly while someone is standing still.
      const coords = [];
      for (const [lng, lat] of points) {
        const here = { lat, lng };
        const last = coords[coords.length - 1];
        if (!last || haversineMeters(last, here) > 0.5) coords.push(here);
      }

      if (coords.length < 2) {
        return res.status(400).json({
          error: 'invalid_trace',
          fields: { points: 'the trace does not go anywhere' },
        });
      }

      const distanceMeters = lineLengthMeters(coords);

      // How far was the recorder from the known graph? This is the useful
      // signal: a trace recorded 80 m off the network is filling a real gap.
      const graph = await graphRepo.getGraph();
      let maxOffGraphMeters = null;
      if (graph.segments.length > 0) {
        let worst = 0;
        for (const p of coords) {
          const snap = snapToGraph(p, graph);
          const d = snap ? snap.distanceMeters : Infinity;
          if (!Number.isFinite(d)) {
            worst = Infinity;
            break;
          }
          if (d > worst) worst = d;
        }
        maxOffGraphMeters = Number.isFinite(worst) ? worst : null;
      }

      const trace = await repo.createTrace({
        coords,
        pointCount: coords.length,
        distanceMeters,
        maxOffGraphMeters,
        note: note ?? null,
        reporterDevice: reporterDevice ?? null,
      });

      res.status(201).json({
        trace: {
          id: trace.id,
          pointCount: trace.pointCount,
          distanceMeters: Math.round(trace.distanceMeters),
          maxOffGraphMeters: trace.maxOffGraphMeters == null
            ? null
            : Math.round(trace.maxOffGraphMeters),
          status: trace.status,
        },
        // A trace the graph already covers is less interesting. Saying so
        // lets the UI acknowledge the walk without implying a gap was fixed.
        duplicatesExistingPath: maxOffGraphMeters != null && maxOffGraphMeters < 15,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── admin-only review ────────────────────────────────────────────────
  const admin = requireAdmin({ repo });

  router.get('/traces', admin, async (req, res, next) => {
    const parsed = listTracesQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_query', fields: formatIssues(parsed.error) });
    }
    try {
      const { items, total } = await repo.listTraces(parsed.data);
      res.json({ items, total });
    } catch (err) {
      next(err);
    }
  });

  // ── merge a trace into the walk graph ──────────────────────────────────
  // This is the step that was missing: until now an approved trace was only a
  // status change, so the loop the app advertises -- walk somewhere unmapped,
  // record it, admin reviews it -- never actually improved routing. Nothing
  // wrote to graph_edges except the OSM importer.
  router.post('/traces/:id/merge', admin, async (req, res, next) => {
    try {
      const merged = await repo.mergeTraceIntoGraph(req.params.id, {
        reviewer: req.user.email,
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : null,
      });

      if (!merged) return res.status(404).json({ error: 'not_found' });

      // The graph repo caches the whole network in memory, so without this the new
      // edge would not appear in routing until the process restarted. The
      // in-memory implementation has to append as well as invalidate, since it
      // has no database row to re-read.
      await graphRepo.edgeAdded?.({
        edgeClass: merged.edge.edgeClass,
        name: merged.edge.name,
        surface: null,
        coords: merged.edge.coords,
      });
      graphRepo.invalidate?.();

      res.json({
        trace: publicTrace(merged.trace),
        edge: merged.edge,
        stats: await graphRepo.getStats(),
      });
    } catch (err) {
      if (err?.code === 'already_merged') {
        return res.status(409).json({ error: 'already_merged' });
      }
      // A trace that collapses below two points is not a path, and inserting it
      // would violate the schema's own ST_NPoints >= 2 constraint. That is a
      // bad submission, not a server fault.
      if (err?.code === 'too_short') {
        return res.status(422).json({ error: 'trace_too_short' });
      }
      next(err);
    }
  });

  router.patch('/traces/:id', admin, async (req, res, next) => {
    const parsed = reviewTraceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_review', fields: formatIssues(parsed.error) });
    }
    try {
      const updated = await repo.reviewTrace(req.params.id, parsed.data);
      if (!updated) return res.status(404).json({ error: 'not_found' });
      res.json({ trace: publicTrace(updated) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Trim a stored trace for the API. */
function publicTrace(t) {
  return {
    id: t.id,
    pointCount: t.pointCount,
    distanceMeters: Math.round(t.distanceMeters),
    maxOffGraphMeters: t.maxOffGraphMeters == null ? null : Math.round(t.maxOffGraphMeters),
    note: t.note,
    status: t.status,
    createdAt: t.createdAt,
  };
}
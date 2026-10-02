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
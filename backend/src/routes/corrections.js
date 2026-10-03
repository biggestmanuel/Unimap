import { Router } from 'express';
import {
  createCorrectionSchema,
  listCorrectionsQuery,
  reviewCorrectionSchema,
  formatIssues,
} from '../lib/validation.js';

/**
 * Student corrections + admin moderation.
 *
 * Submissions never touch `pois`. They land in `corrections` as pending
 * proposals, and only an approved review applies them. That separation
 * is the whole point: campus data is load-bearing, so it is never
 * writable by an anonymous student request.
 */
export default function createCorrectionRoutes(repo, { requireAdmin } = {}) {
  const router = Router();

  // ── Student: submit a correction ──────────────────────────────
  router.post('/corrections', async (req, res, next) => {
    const parsed = createCorrectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid_correction', fields: formatIssues(parsed.error) });
    }

    try {
      const payload = parsed.data;

      // Catch a typo'd or stale id before it becomes a 500 from the FK.
      if (payload.poiId) {
        const existing = await repo.getPoi(payload.poiId);
        if (!existing) {
          return res.status(404).json({ error: 'unknown_poi', message: 'that location no longer exists' });
        }
      }

      const created = await repo.createCorrection(payload);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // ── Student: list your own submissions (by device) ───────────
  router.get('/corrections/mine', async (req, res, next) => {
    try {
      const device = String(req.query.device ?? '').trim();
      if (!device) {
        return res.status(400).json({ error: 'invalid_query', fields: { device: 'required' } });
      }
      const { items } = await repo.listCorrections({ reporterDevice: device, limit: 50, offset: 0 });
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // ── Admin: moderation queue ──────────────────────────────────
  router.get('/admin/corrections', requireAdmin, async (req, res, next) => {
    const parsed = listCorrectionsQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_query', fields: formatIssues(parsed.error) });
    }

    try {
      const { status, limit, offset } = parsed.data;
      const { items, total } = await repo.listCorrections({ status, limit, offset });
      res.json({ items, total, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // ── Admin: approve or reject ─────────────────────────────────
  router.patch('/admin/corrections/:id', requireAdmin, async (req, res, next) => {
    const parsed = reviewCorrectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_review', fields: formatIssues(parsed.error) });
    }

    try {
      // `reviewer` comes from the session, not the body -- see the note in
      // routes/trace.js. A client-supplied reviewer would let an admin forge an
      // audit entry naming someone else.
      const { status, note } = parsed.data;
      const result = await repo.reviewCorrection(req.params.id, {
        status,
        note,
        reviewer: req.user.email,
      });
      if (!result) return res.status(404).json({ error: 'not_found' });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
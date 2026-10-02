import { Router } from 'express';
import { listPoisQuery, poiIdParam, formatIssues } from '../lib/validation.js';

/**
 * POI read routes.
 *
 * `repo` is injected rather than imported so the whole HTTP surface can
 * be tested with an in-memory double and no database.
 */
export default function createPoiRoutes(repo) {
  const router = Router();

  router.get('/pois', async (req, res, next) => {
    const parsed = listPoisQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_query', fields: formatIssues(parsed.error) });
    }

    try {
      const { q, category, limit, offset } = parsed.data;
      const { items, total } = await repo.listPois({ q, category, limit, offset });
      res.json({ items, total, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  router.get('/pois/:id', async (req, res, next) => {
    const parsed = poiIdParam.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_id', fields: formatIssues(parsed.error) });
    }

    try {
      const poi = await repo.getPoi(parsed.data.id);
      if (!poi) return res.status(404).json({ error: 'not_found' });
      res.json(poi);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
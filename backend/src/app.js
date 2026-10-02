import express from 'express';
import cors from 'cors';
import createPoiRoutes from './routes/pois.js';
import createCorrectionRoutes from './routes/corrections.js';

/**
 * App factory. The repository is a parameter so tests can inject an
 * in-memory double and exercise the real HTTP surface without Postgres.
 */
export default function createApp({ repo, requireAdmin } = {}) {
  if (!repo) throw new Error('createApp requires a repo');

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'unimap-api' });
  });

  app.use('/api', createPoiRoutes(repo));
  app.use('/api', createCorrectionRoutes(repo, { requireAdmin: requireAdmin ?? denyInProduction }));

  // 404 for anything unmatched, so clients get JSON not HTML.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/**
 * Placeholder gate. Real auth lands with the admin panel — this exists
 * so the protected routes are unreachable-by-accident in the meantime
 * rather than wide open in production.
 */
function denyInProduction(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(501).json({
      error: 'admin_api_disabled',
      message: 'set up admin auth before deploying',
    });
  }
  next();
}
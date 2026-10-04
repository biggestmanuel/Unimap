import express from 'express';
import cors from 'cors';
import createPoiRoutes from './routes/pois.js';
import createCorrectionRoutes from './routes/corrections.js';
import createRouteRoutes from './routes/route.js';
import createAuthRoutes from './routes/auth.js';
import createAdminRoutes from './routes/admin.js';
import createTraceRoutes from './routes/trace.js';
import { makeRequireAdmin } from './routes/auth.js';
import { publicWriteLimiter, readLimiter } from './lib/rateLimit.js';
import { securityHeaders } from './lib/csp.js';

/**
 * App factory. The repository is a parameter so tests can inject an
 * in-memory double and exercise the real HTTP surface without Postgres.
 */
export default function createApp({ repo, graphRepo, requireAdmin } = {}) {
  if (!repo) throw new Error('createApp requires a repo');

  // A missing graphRepo is survivable: routing degrades to the straight-line
  // fallback rather than the API refusing to boot.
  graphRepo ??= {
    async getGraph() {
      return { adj: new Map(), segments: [] };
    },
    async getStats() {
      return {
        totalWays: 0,
        groups: 0,
        mainWays: 0,
        routableMeters: 0,
        totalMeters: 0,
        deadEndCount: 0,
        byClass: [],
        islands: [],
      };
    },
  };

  const app = express();

  // Behind a reverse proxy, req.ip is the proxy unless this is set. Without
  // it every client shares one rate-limit bucket, so one busy campus can lock
  // out everyone.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 1);

  // Before anything that could produce a response body, including the error
  // handlers at the bottom, so a reflected string can never be treated as a
  // document.
  app.use(securityHeaders());

  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'unimap-api' });
  });

  // `requireAdmin` is a middleware, injectable so tests can stub it. The
  // default is the real role check.
  const adminGate = requireAdmin ?? makeRequireAdmin({ repo });

  // Reads are cheap and plentiful; a wide net catches runaway polling.
  app.use('/api', readLimiter);

  // These two are public by design and expensive: a trace is up to 20,000
  // coordinates snapped against the whole graph. Tight limit, applied before
  // the handler so a rejected request costs nothing.
  app.use('/api/traces', publicWriteLimiter);
  app.use('/api/corrections', publicWriteLimiter);

  app.use('/api', createPoiRoutes(repo));
  app.use('/api', createRouteRoutes({ graphRepo, repo }));
  app.use('/api', createTraceRoutes({
    repo,
    graphRepo,
    // The trace router builds its own admin gate from the same policy.
    requireAdmin: makeRequireAdmin,
  }));
  app.use('/api', createAuthRoutes({ repo }));
  app.use('/api', createAdminRoutes({ repo, graphRepo, requireAdmin: adminGate }));
  app.use('/api', createCorrectionRoutes(repo, { requireAdmin: adminGate }));

  // 404 for anything unmatched, so clients get JSON not HTML.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Body-parser failures are the client's fault, not ours. Without this
    // they fall through to a 500, which tells a caller their malformed
    // request was our outage.
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'invalid_json' });
    }

    console.error('[api]', err);
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
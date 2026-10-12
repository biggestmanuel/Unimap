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
 * Parse the `TRUST_PROXY` environment variable into something Express accepts.
 *
 * Express accepts a boolean, a hop count, a function, or a list of addresses.
 * An environment variable is always a string, and Express reads *any* string as
 * an address list -- so `TRUST_PROXY=false` does not disable proxy trust, it
 * throws `TypeError: invalid IP address: false` during startup, and the deploy
 * fails with a stack trace that says nothing about the cause.
 *
 * Measured across the spellings someone would plausibly reach for:
 * `0`, `1`, `2` accepted (numeric strings become a hop count); `false`, `no`,
 * `off`, `true` and `yes` all crash. Every one of those is a reasonable thing
 * to type, and the ones that mean the opposite of what they look like are the
 * dangerous ones.
 *
 * So: parse the intent. Digits are a hop count, the usual words are booleans,
 * and anything else is rejected with a message that names the variable.
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;

  const value = String(raw).trim().toLowerCase();

  if (/^\d+$/.test(value)) return Number(value);

  if (['false', 'no', 'off', 'none', 'disabled'].includes(value)) return false;
  if (['true', 'yes', 'on', 'enabled'].includes(value)) return true;

  throw new Error(
    `TRUST_PROXY is "${raw}", which is neither a hop count nor a boolean. `
    + 'Use a number of proxy hops to trust (1 is right for Render), or one of '
    + 'true/false. Leaving it unset trusts one hop.',
  );
}

/**
 * Describe Express's `trust proxy` setting for the health endpoint.
 *
 * Reports whether proxy trust is on, and how many hops, without echoing a
 * function or an address list. Anything unrecognised reports as `enabled: true`
 * with a null `hops`, because an unknown setting that is not literally `false`
 * still trusts somebody -- and the thing worth asserting is that trust is on at
 * all, not exactly how.
 */
function describeTrustProxy(setting) {
  if (setting === false) return { enabled: false, hops: null };
  if (typeof setting === 'number') return { enabled: true, hops: setting };
  if (typeof setting === 'boolean') return { enabled: setting, hops: null };
  return { enabled: true, hops: null };
}

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
  //
  // Defaults to trusting one hop, which is right for a single reverse proxy and
  // safe with no configuration at all. An earlier version of this file's
  // comments treated a missing TRUST_PROXY as the dangerous case; it is not.
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

  // Before anything that could produce a response body, including the error
  // handlers at the bottom, so a reflected string can never be treated as a
  // document.
  app.use(securityHeaders());

  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (req, res) => {
    // The build stamp exists because "is production running current code?" is
    // otherwise unanswerable from outside. It cost a real debugging session: a
    // fix was verified locally, pushed, and appeared to have no effect on the
    // live site, because the live site was still running an older build. Now the
    // answer is one request.
    //
    // Read from the environment rather than baked in at build time, so it works
    // identically whether the app is started by npm, Render, or a bare `node`.
    //
    // `trustProxy` is here because it is otherwise invisible and its failure is
    // silent: with proxy trust disabled, every request appears to come from the
    // proxy, so every student shares one rate-limit bucket and one busy moment
    // locks out the whole campus. Nobody notices until it happens in production,
    // and it cannot be diagnosed from outside. Reporting it means
    // `npm run check:live` can assert it, instead of relying on somebody
    // remembering to look at a dashboard.
    res.json({
      ok: true,
      service: 'unimap-api',
      version: process.env.APP_VERSION ?? 'dev',
      commit: process.env.RENDER_GIT_COMMIT ?? null,
      branch: process.env.RENDER_GIT_BRANCH ?? null,
      trustProxy: describeTrustProxy(app.get('trust proxy')),
      time: new Date().toISOString(),
    });
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
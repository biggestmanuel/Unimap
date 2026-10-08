/**
 * End-to-end smoke test against the LIVE deployment.
 *
 * Everything else in this suite runs against fixtures or an in-memory double.
 * This one talks to whatever is actually deployed, which is the only way to
 * catch the failures that unit tests structurally cannot: a stale build, a
 * missing environment variable, a cross-origin rejection, a database that was
 * never migrated.
 *
 * Read-only by design. It creates nothing and deletes nothing, so it is safe to
 * run against production at any time.
 *
 *   node scripts/verifyLive.js [apiBase] [siteBase]
 */

import { execFileSync } from 'node:child_process';

const api = process.argv[2] ?? process.env.E2E_API ?? 'https://unimap-wvvk.onrender.com';
const site = process.argv[3] ?? process.env.E2E_SITE ?? 'https://unimap-sch.vercel.app';

const problems = [];
const notes = [];

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(label);
}

function note(label, detail) {
  console.log(`  note  ${label}${detail ? `  ${detail}` : ''}`);
  notes.push(label);
}

async function get(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, text, headers: res.headers };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

console.log(`API  ${api}`);
console.log(`SITE ${site}\n`);

// ── 1. the API is up, and running current code ───────────────────────
console.log('1. API health');
const health = await get(`${api}/health`);
check('reachable', health.status === 200, health.error ?? `HTTP ${health.status}`);
if (health.body) {
  check('reports ok', health.body.ok === true);
  check('reports a version', Boolean(health.body.version),
    `version=${health.body.version} commit=${health.body.commit ?? 'n/a'}`);
}

// ── 2. security headers ──────────────────────────────────────────────
console.log('\n2. security headers');
if (health.headers) {
  check('nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  const csp = health.headers.get('content-security-policy') ?? '';
  check('CSP present', Boolean(csp), csp.slice(0, 50) || '(absent)');
  check("CSP sets frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
}

// ── 3. the graph is real ─────────────────────────────────────────────
console.log('\n3. walk graph');
const stats = await get(`${api}/api/graph/stats`);
check('stats reachable', stats.status === 200, stats.error ?? '');
if (stats.body) {
  const s = stats.body;
  check('has ways', s.totalWays > 300, `ways=${s.totalWays}`);
  check('has connected groups', s.connectedGroups > 0, `groups=${s.connectedGroups}`);
  check('routable metres present', s.routableMeters > 0, `${s.routableMeters}m`);
  check('dead ends are plausible', s.deadEndCount <= s.totalWays,
    `deadEnds=${s.deadEndCount} across ${s.totalWays} ways `
    + '(more dead ends than ways means the metric is counting endpoints)');
  check('islands are traced', Array.isArray(s.islands) && s.islands.length > 0,
    `${s.islands?.length ?? 0} islands`);
}

// ── 4. routing actually works ────────────────────────────────────────
console.log('\n4. routing');
const route = await get(`${api}/api/route`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: { lat: 4.7972, lng: 6.9819 },
    to: { lat: 4.7903, lng: 6.9790 },
  }),
});
check('route endpoint', route.status === 200, route.error ?? `HTTP ${route.status}`);
if (route.body) {
  check('finds a path', route.body.found === true,
    route.body.found ? `${route.body.distanceMeters}m` : `reason=${route.body.reason}`);
  check('returns coordinates', Array.isArray(route.body.coords) && route.body.coords.length >= 2,
    `${route.body.coords?.length ?? 0} points`);
  check('returns legs', Array.isArray(route.body.legs) && route.body.legs.length > 0,
    `${route.body.legs?.length ?? 0} legs`);
}

// ── 5. search works ──────────────────────────────────────────────────
console.log('\n5. search');
const search = await get(`${api}/api/pois?q=hostel`);
check('search endpoint', search.status === 200, search.error ?? '');
if (search.body) {
  check('returns matches', (search.body.total ?? 0) > 0, `${search.body.total} matches`);
}

// ── 6. auth is closed by default ─────────────────────────────────────
console.log('\n6. auth');
for (const path of ['/api/admin/summary', '/api/admin/users', '/api/traces']) {
  const res = await get(`${api}${path}`);
  check(`${path} is 401 without a token`, res.status === 401, `HTTP ${res.status}`);
}
const badLogin = await get(`${api}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'nobody@example.invalid', password: 'wrong-password' }),
});
check('a bad login is 401', badLogin.status === 401, `HTTP ${badLogin.status}`);

// ── 7. the public write is rate limited ──────────────────────────────
console.log('\n7. rate limiting');
// A trace that goes nowhere is rejected by validation before it can cost
// anything, but the limiter sits in front of the handler, so this still
// exercises the middleware.
//
// `publicWriteLimiter` is capacity 12, refill one per 10s, so 13 requests is
// the fewest that can prove the limiter works. It used to send 20, which bought
// nothing and emptied the bucket twice over.
//
// The residual cost is real and worth stating rather than hiding: this leaves
// the calling client's bucket empty for about ten seconds, so a student behind
// the same NAT could be refused one trace submission if this is run while they
// are using the app. Run it, then leave it alone for a minute.
//
// That cost is only small because buckets are keyed by `req.ip`. Without
// `trust proxy` — the `TRUST_PROXY` environment variable on Render — every
// request appears to come from the proxy, so *all* users share one bucket and
// this check rate-limits the entire campus. That cannot be verified from
// outside, so it is stated rather than asserted.
let limited = false;
let retryAfter = null;
for (let i = 0; i < 13; i += 1) {
  const res = await get(`${api}/api/traces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [[6.98, 4.79]] }),
  });
  if (res.status === 429) {
    limited = true;
    retryAfter = res.headers?.get('retry-after') ?? null;
    break;
  }
}
// `Retry-After` from the 429, not `X-RateLimit-Remaining` from the responses
// before it. `/api/traces` also passes through the read limiter, whose capacity
// is 120, so the remaining count belongs to a different bucket and says
// nothing about the write limiter being tested here.
check('the public write endpoint rate limits', limited,
  limited ? `Retry-After: ${retryAfter ?? 'absent'}s` : '');
note('bucket state',
  'this emptied the calling client\'s bucket for ~10s; check TRUST_PROXY=1 on Render');

// ── 8. the frontend is served, and points at this API ────────────────
console.log('\n8. frontend');
for (const path of ['/', '/admin.html', '/manifest.webmanifest']) {
  const res = await get(`${site}${path}`);
  check(`${path} is served`, res.status === 200, `HTTP ${res.status}`);
}

// The API base is baked in at build time. If it were missing, every request
// would go to /api on the Vercel domain and 404 -- the map would render and
// nothing would load, with no obvious error.
const home = await get(site);
if (home.text) {
  const scripts = [...home.text.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  let found = false;
  for (const src of scripts.slice(0, 6)) {
    const js = await get(`${site}${src}`);
    if (js.text && js.text.includes(api.replace(/^https?:\/\//, ''))) { found = true; break; }
  }
  check('the bundle points at this API', found,
    found ? '' : `no reference to ${api} in ${scripts.length} asset(s) — VITE_API_BASE may be unset`);
}

// ── 9. the deployed build is current ─────────────────────────────────
// Comparing the live commit against local HEAD is the only staleness check
// that does not rot. An earlier version of this script hardcoded the old
// dead-end count and asked "is it still 344?" -- which stops being evidence
// the moment 344 is fixed twice, and says nothing about any later change.
console.log('\n9. build currency');

let localHead = null;
try {
  localHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  note('no local git', 'could not read HEAD, so the build cannot be compared');
}

const liveCommit = health.body?.commit ?? null;

if (!liveCommit) {
  check('the live build reports its commit', false,
    'absent, so the deployment predates the /health version stamp');
} else if (!localHead) {
  note('live commit', liveCommit.slice(0, 7));
} else if (liveCommit === localHead) {
  check('running the current commit', true, liveCommit.slice(0, 7));
} else {
  check('running the current commit', false,
    `live ${liveCommit.slice(0, 7)} vs local ${localHead.slice(0, 7)} `
    + '— Render has not redeployed. Nothing else in this report can be trusted '
    + 'until it has: a fix that "has no effect" is almost always an old build.');
}

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(64)}`);
if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`\n${problems.length} problem(s) against ${api}\n`);
  process.exit(1);
}
console.log('All live checks passed.');
for (const n of notes) console.log(`  note  ${n}`);
console.log();

/**
 * Pre-commit checks.
 *
 * Each one here catches a mistake that actually happened in this project, and
 * each is cheap enough to run every time. Documentation does not prevent
 * anything; a check that fails does.
 *
 *   node scripts/verify.js
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findSecrets, isPlaceholderValue, isLocalMatch, PG_URL_RE, LOCAL_HOST_RE,
} from './lib/secretScan.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const problems = [];
const warnings = [];

const fail = (m) => problems.push(m);
const warn = (m) => warnings.push(m);
const ok = (m) => console.log(`  ok    ${m}`);

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

/** Files git is actually tracking, so scratch files are not scanned. */
function trackedFiles() {
  const out = git('ls-files');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const SOURCE_EXT = /\.(js|jsx|mjs|css|json|md|html|sql|yml|yaml)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'test-results', 'playwright-report', 'coverage']);

/** Every source file in the repo, tracked or not, minus build output. */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (SOURCE_EXT.test(name)) acc.push(full);
  }
  return acc;
}

// ── 1. no credentials in tracked files ───────────────────────────────
// A connection string and an admin password both appeared in this repository's
// history during setup, in a screenshot and in a transcript.
console.log('\n1. credentials in tracked files');

let scanned = 0;
for (const file of trackedFiles()) {
  if (!SOURCE_EXT.test(file)) continue;
  let text;
  try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
  scanned += 1;
  for (const { what } of findSecrets(text, file)) {
    fail(`${file} appears to contain ${what}`);
  }
}
if (!problems.length) ok(`no credentials in ${scanned} tracked source files`);

// ── 2. .env must never be tracked ───────────────────────────────────
// The backend reads DATABASE_URL from the environment and has no dotenv
// dependency, so `.env` holding the only copy of a working connection string is
// both a security risk and a single point of failure.
console.log('\n2. .env handling');

if (git('ls-files', '--error-unmatch', 'backend/.env').trim()) {
  fail('backend/.env is tracked by git — it must be ignored');
} else {
  ok('backend/.env is not tracked');
}

const ignore = git('check-ignore', '-v', 'backend/.env');
if (!ignore.trim()) {
  fail('backend/.env is not in .gitignore');
} else {
  ok(`backend/.env ignored via ${ignore.split(':')[0]}`);
}

// The template lives at the repo root, not beside the .env it describes:
// DATABASE_URL is read by the backend but the copy-paste step happens once.
for (const f of ['.env.example', 'frontend/.env.example']) {
  if (!exists(join(ROOT, f))) fail(`${f} is missing; a newcomer has no template to copy`);
}
if (!problems.some((p) => p.includes('.env.example'))) ok('.env.example templates present');

for (const f of ['.env.example', 'frontend/.env.example']) {
  const full = join(ROOT, f);
  if (!exists(full)) continue;
  const text = readFileSync(full, 'utf8');
  // A template that contains a real credential is worse than no template.
  //
  // localhost is exempt: `postgres://unimap:unimap_dev@localhost` is the local
  // docker-compose default, not a secret. What must never appear here is a
  // connection string pointing at a real host.
  const host = text.match(PG_URL_RE)?.[1] ?? null;
  if (host && !LOCAL_HOST_RE.test(host)) {
    fail(`${f} contains a connection string for a non-local host (${host}); `
      + 'a template must stay blank');
  }
  for (const { what } of findSecrets(text, f)) {
    fail(`${f} contains ${what}; a template must stay blank`);
  }
}

function exists(p) {
  try { statSync(p); return true; } catch { return false; }
}

// ── 3. the frontend port is load-bearing ─────────────────────────────
// Several projects on this machine default to 5173. With Playwright's
// `reuseExistingServer` on, this suite ran against a different app and reported
// green. That is the worst possible failure mode.
console.log('\n3. the e2e port is consistent');

const pw = join(ROOT, 'frontend', 'playwright.config.js');
if (!exists(pw)) {
  warn('playwright.config.js not found');
} else {
  const text = readFileSync(pw, 'utf8');
  const port = text.match(/const PORT = (\d+)/)?.[1];
  if (port !== '5199') {
    fail(`playwright.config.js uses port ${port ?? '(unset)'}, expected 5199`);
  } else if (/reuseExistingServer:\s*true/.test(text)) {
    fail('playwright.config.js sets reuseExistingServer: true — the suite can '
      + 'run against another project\'s dev server and report green');
  } else {
    ok('port 5199, and reuseExistingServer is false');
  }

  const vite = readFileSync(join(ROOT, 'frontend', 'vite.config.js'), 'utf8');
  const vitePort = vite.match(/port:\s*(\d+)/)?.[1];
  if (vitePort && vitePort !== '5199') {
    fail(`vite.config.js serves on ${vitePort} but the e2e config expects 5199`);
  } else {
    ok('vite dev port matches the e2e port');
  }
}

// ── 4. shell scripts must be bash-safe ───────────────────────────────
// The agent shell here is PowerShell, which cannot run `&&` chains or heredocs.
// A .sh script that relies on those will fail confusingly when run.
console.log('\n4. shell scripts');

for (const file of trackedFiles()) {
  if (!/\.(sh|bash)$/.test(file)) continue;
  const text = readFileSync(join(ROOT, file), 'utf8');
  if (/<<-?\s*['"]?\w+['"]?/.test(text)) {
    warn(`${file} uses a heredoc; fine in bash, but not if run through PowerShell`);
  }
  if (!text.startsWith('#!')) {
    warn(`${file} has no shebang`);
  }
}
ok('shell scripts inspected');

// ── 5. the README must describe the app that exists ─────────────────
// Documentation drifts silently. These checks are about the claims most likely
// to become wrong, and that matter to someone picking this up.
console.log('\n5. README accuracy');

const readme = join(ROOT, 'README.md');
if (!exists(readme)) {
  fail('README.md is missing');
} else {
  const text = readFileSync(readme, 'utf8');

  // The documented dev port must be the real one.
  if (/localhost:5173/.test(text)) {
    fail('README says the dev server is on 5173; it is 5199');
  } else if (/localhost:5199/.test(text)) {
    ok('README documents the correct dev port');
  } else {
    warn('README does not state a dev port');
  }

  // VITE_API_BASE is the one variable that silently breaks a deployment.
  if (/VITE_API_BASE/.test(text)) ok('README documents VITE_API_BASE');
  else fail('README does not mention VITE_API_BASE; omitting it breaks every request');

  // Every script the README tells a newcomer to run must exist.
  //
  // The match is anchored to a full word so `npm run test:e2e` does not read as
  // the script `test:e`. A regex that truncates at the colon reports a script
  // that plainly exists as missing, which is worse than not checking.
  //
  // The root package.json counts. It did not, and the omission was invisible:
  // `check` and `test` exist in the sub-packages too, so the only root-only
  // script the README mentions, `check:live`, was the first to expose it.
  const scripts = [...text.matchAll(/npm run ([a-z][a-z0-9]*(?::[a-z0-9]+)*)/g)].map((m) => m[1]);
  const known = new Set();
  for (const pkg of ['', 'backend', 'frontend']) {
    const json = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8'));
    for (const name of Object.keys(json.scripts ?? {})) known.add(name);
  }
  const missing = [...new Set(scripts)].filter((s) => !known.has(s));
  if (missing.length) {
    fail(`README references script(s) that do not exist: ${missing.join(', ')}`);
  } else if (scripts.length) {
    ok(`all ${new Set(scripts).size} npm scripts in the README exist`);
  }

  // Docs referenced by the README must exist.
  for (const m of text.matchAll(/\]\(\.\/([\w./-]+\.md)\)/g)) {
    if (!exists(join(ROOT, m[1]))) fail(`README links to ./${m[1]}, which does not exist`);
  }
  ok('README internal links resolve');
}

// ── 6. no scratch files left behind ──────────────────────────────────
// Several debugging scripts accumulate in backend/ during a session.
console.log('\n6. no scratch files committed');

const SCRATCH = /^[_].*\.(mjs|js)$/;
for (const file of trackedFiles()) {
  const base = file.split('/').pop() ?? '';
  if (SCRATCH.test(base)) {
    fail(`${file} looks like a scratch file and should not be committed`);
  }
}
if (!problems.some((p) => p.includes('scratch'))) ok('no scratch files tracked');

for (const dir of ['backend', 'frontend']) {
  const full = join(ROOT, dir);
  if (!exists(full)) continue;
  for (const name of readdirSync(full)) {
    if (SCRATCH.test(name)) {
      warn(`${relative(ROOT, join(full, name))} exists on disk but is untracked — delete it when done`);
    }
  }
}

// ── 7. the walk graph is present and shaped ───────────────────────────
// Without it the app routes in straight lines, which it presents as a guess.
console.log('\n7. walk graph present');

const graphPath = join(ROOT, 'frontend', 'public', 'data', 'walk-graph.json');
if (!exists(graphPath)) {
  fail('frontend/public/data/walk-graph.json is missing; a fresh clone cannot route');
} else {
  try {
    const rows = JSON.parse(readFileSync(graphPath, 'utf8'));
    if (!Array.isArray(rows) || rows.length === 0) {
      fail('walk-graph.json is empty');
    } else {
      const bad = rows.filter((r) => !Array.isArray(r.coords) || r.coords.length < 2);
      if (bad.length) fail(`${bad.length} edge(s) in walk-graph.json have no usable coords`);
      else ok(`walk-graph.json: ${rows.length} edges, all with geometry`);
    }
  } catch (err) {
    fail(`walk-graph.json is not valid JSON: ${err.message}`);
  }
}

// ── 8. the credential scanner still detects credentials ──────────────
// Check 1 is worthless if the scanner has stopped working, and it did stop
// working without anyone noticing: the placeholder exemption matched the
// substring "example" anywhere in a value, so AWS's own documented example key
// id passed clean -- as would any real password containing that word. A
// security check that can be defeated by a substring needs its own test, run
// from the same place as the check itself.
//
// The probe strings live in `lib/secretScan.probes.json` and are read from
// there, so they cannot drift from the rules they exercise. That file is exempt
// from check 1, as it has to contain things that look like secrets in order to
// prove they are caught.
console.log('\n8. credential scanner still detects credentials');

const probesPath = join(ROOT, 'scripts', 'lib', 'secretScan.probes.json');
if (!exists(probesPath)) {
  fail('scripts/lib/secretScan.probes.json is missing, so check 1 cannot be trusted');
} else {
  const { cases } = JSON.parse(readFileSync(probesPath, 'utf8'));
  for (const { label, sample, shouldCatch } of cases) {
    const caught = findSecrets(sample).length > 0;
    if (caught !== shouldCatch) {
      fail(`scanner ${caught ? 'flagged' : 'missed'} "${label}" `
        + `but should ${shouldCatch ? 'flag it' : 'not flag it'}`);
    }
  }
  if (!problems.some((p) => p.startsWith('scanner '))) {
    ok(`scanner behaves correctly on all ${cases.length} probe strings`);
  }
}

// ── summary ──────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(64));
for (const w of warnings) console.log(`  warn  ${w}`);
if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`\n${problems.length} problem(s). Not safe to commit yet.\n`);
  process.exit(1);
}
console.log(warnings.length
  ? `\nNo blocking problems, ${warnings.length} warning(s).\n`
  : '\nAll checks passed.\n');
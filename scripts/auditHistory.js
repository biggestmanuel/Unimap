/**
 * History-wide secret audit.
 *
 * `npm run check` scans the files in the working tree. That is the right check
 * for a commit, and it is blind to the case that actually matters after an
 * incident: a credential that was committed once and then deleted. The value is
 * still in the object store, it is still in every clone, and if it was ever
 * pushed it is on the remote permanently.
 *
 * This scans every blob reachable from every ref, every unreachable object, and
 * every commit message.
 *
 * NOTHING IT PRINTS IS A SECRET. Every finding is reduced to a rule name, a
 * path, a line number, and structural facts: the scheme, the username, the host,
 * and the *length* of anything that could be a password. Those are enough to
 * decide whether to rotate something, which a redacted string is not.
 *
 * Run it:
 *   npm run audit:history
 *
 * Roughly 50 seconds, so it is deliberately not part of `npm run check`. Run it
 * before making a repository public, before sharing a clone, and after any
 * suspected credential exposure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.argv[2] ?? process.cwd();
const { SECRET_PATTERNS, isPlaceholderValue, isLocalMatch, LOCAL_HOST_RE } =
  await import(new URL('./lib/secretScan.js', import.meta.url).href);

const BOLD = process.stdout.isTTY;
const dim = (s) => (BOLD ? `\u001b[2m${s}\u001b[0m` : s);
const red = (s) => (BOLD ? `\u001b[31m${s}\u001b[0m` : s);
const yellow = (s) => (BOLD ? `\u001b[33m${s}\u001b[0m` : s);
const green = (s) => (BOLD ? `\u001b[32m${s}\u001b[0m` : s);

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
}

// ── rules ────────────────────────────────────────────────────────────
// The repository's own rules, plus several it lacks. A scanner that only knows
// about Postgres URLs will happily bless a history containing a Slack webhook.

const EXTRA_PATTERNS = [
  [/\b(?:mysql|mongodb(?:\+srv)?|redis|amqp|ftp):\/\/[^\s:/@'"]+:[^\s/@'"]{4,}@[^\s'"]+/gi,
    'a non-Postgres connection string with an inline password'],
  [/\b(?:https?|ftp|ssh):\/\/[^\s:/@'"]+:[^\s/@'"]{8,}@[^\s'"]+/gi,
    'a URL with an inline password'],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"](?<value>[^'"\s]{6,})['"]/gi,
    'a hardcoded secret assignment'],
  [/hooks\.slack\.com\/services\/\S+/g, 'a Slack webhook URL'],
  [/\bdiscord(?:app)?\.com\/api\/webhooks\/\S+/g, 'a Discord webhook URL'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'a JWT'],
];

const ALL_PATTERNS = [
  ...SECRET_PATTERNS.map(([re, what]) => [re, what, 'repo']),
  ...EXTRA_PATTERNS.map(([re, what]) => [re, what, 'extra']),
];

/**
 * Files whose contents are synthetic on purpose. Reported and counted, never
 * hidden, so a reviewer sees them and can agree rather than trusting a silent
 * skip.
 *
 * The scanners themselves are on this list, and have to be: a file that defines
 * secret patterns necessarily contains text in the shape of a secret, so
 * exempting it by name is the only option that does not mean weakening the
 * pattern. The live-credential assertion below covers what that exemption gives
 * up -- it is a direct search for the actual value, not a shape guess.
 */
const KNOWN_SYNTHETIC = [
  'scripts/lib/secretScan.probes.json',
  'scripts/auditHistory.js',
  'scripts/lib/secretScan.js',
  'backend/.env.example',
  'frontend/.env.example',
  'docs/SECURITY.md',
  'README.md',
  'AGENTS.md',
  'PLAN.md',
  'OVERNIGHT-PLAN.md',
];

/**
 * Words that appear in a test fixture's password and essentially never in a
 * real one. Used only to *classify* a finding as benign, and always alongside a
 * second signal, so a real credential that happens to contain "test" is still
 * reported.
 */
const FIXTURE_WORDS = [
  'password', 'passwd', 'secret', 'correct', 'wrong', 'hunter', 'unimap',
  'admin', 'test', 'testing', 'example', 'placeholder', 'abc123', 'letmein',
  'cisco', 'rivers', 'state', 'campus', 'stronger', 'weak', 'good', 'bad',
  'valid', 'invalid', 'user', 'demo', 'fake', 'stub', 'fixture', 'foobar',
  'qwerty', 'dummy', 'sample', 'horse', 'battery', 'staple', 'correcthorse',
];

/**
 * Is this password-shaped literal a test fixture rather than a credential?
 *
 * Two independent conditions, and both must hold:
 *
 *   - the file is a test, by path
 *   - the literal uses at most two character classes
 *
 * The second is what makes this safe rather than a directory whitelist. Real
 * credentials overwhelmingly use three or four; every fixture in this
 * repository's history uses two. A real secret pasted into a test file is
 * therefore still reported, which a `skip everything under test/` exemption
 * would not achieve.
 *
 * The reuse count is reported alongside, because a literal pasted into six test
 * files and a literal pasted once read very differently to a human even when
 * both are fixtures.
 */
function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__|e2e|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path);
}

function classifyFixture(value, path, hits) {
  const classes = ['[a-z]', '[A-Z]', '[0-9]', '[^A-Za-z0-9]'].filter((c) => (
    c === '[a-z]' ? /[a-z]/.test(value)
      : c === '[A-Z]' ? /[A-Z]/.test(value)
        : c === '[0-9]' ? /[0-9]/.test(value)
          : /[^A-Za-z0-9]/.test(value)
  )).length;

  if (!path || !isTestPath(path)) return null;
  if (classes > 2) return null;

  const words = FIXTURE_WORDS.filter((w) => value.toLowerCase().includes(w));
  return [`in a test file`, `${classes} character classes`,
    `seen ${hits}x`, words.length ? `fixture words: ${words.join(', ')}` : null]
    .filter(Boolean).join('; ');
}

// ── redaction ────────────────────────────────────────────────────────

/**
 * Reduce a match to facts. Never returns anything that could be the secret.
 *
 * When the rule captured a named `value` group, that group is what gets
 * measured. Measuring the whole match instead includes the key name and the
 * quotes, so a 14-character password is reported as 26 -- which reads like a
 * far longer credential than the one actually present, and is the kind of
 * detail that makes a reviewer doubt a report that is otherwise fine.
 */
function describe(sample, value) {
  const subject = value ?? sample;
  const url = subject.match(/^([a-z][a-z0-9+.-]*):\/\/([^:/@\s]+)(?::([^@/\s]*))?@([^/\s'"]+)/i);
  if (!url) {
    const cls = (c) => (/[a-z]/.test(c) ? 'a' : /[A-Z]/.test(c) ? 'A' : /\d/.test(c) ? '9' : c);
    return `valueLen=${subject.length} starts=${cls(subject[0] ?? ' ')}`;
  }
  const [, scheme, user, pass, host] = url;
  return [
    `scheme=${scheme}`,
    `user=${user}`,
    pass === undefined ? '' : `valueLen=${pass.length}`,
    `host=${LOCAL_HOST_RE.test(host) ? 'LOCALHOST' : maskHost(host)}`,
  ].filter(Boolean).join(' ');
}

/** Keep only the registrable tail of a hostname. */
function maskHost(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return `${parts[0]}.***`;
  return `${parts.slice(-2).join('.')} (${parts.length} labels)`;
}

// ── scan ─────────────────────────────────────────────────────────────

const ASSIGNMENT_RULE = 'a hardcoded secret assignment';

function scan(text, where, path, stillCurrent = false) {
  const hits = [];
  for (const [re, what, origin] of ALL_PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    for (const m of text.matchAll(new RegExp(re.source, flags))) {
      if (isPlaceholderValue(m[0])) continue;
      if (isLocalMatch(m)) continue;
      const value = what === ASSIGNMENT_RULE && m.groups ? m.groups.value : undefined;
      const hit = {
        where,
        path,
        what,
        origin,
        line: text.slice(0, m.index).split('\n').length,
        info: describe(m[0], value),
        // An old version of a file is reported differently from the current
        // one. "committed in the past but the file has since changed" is a much
        // weaker statement than "in the file as it stands today", and conflating
        // them is how an audit talks someone into a pointless rotation.
        current: stillCurrent,
        synthetic: path !== null && KNOWN_SYNTHETIC.some((p) => path.startsWith(p) || path.endsWith(p)),
        committed: path !== null,
      };
      // Held in memory only, so the assignment rule can be classified below.
      // Never printed, never written to disk.
      if (value) hit.value = value;
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * Decide which assignment findings are fixtures, and record why.
 *
 * Runs after every blob has been scanned, so it can count how often each
 * literal occurs.
 */
function classifyAssignments(hits) {
  const counts = new Map();
  for (const h of hits) {
    if (h.value) counts.set(h.value, (counts.get(h.value) ?? 0) + 1);
  }

  const reasons = [];
  for (const h of hits) {
    if (!h.value || h.synthetic) continue;
    const why = classifyFixture(h.value, h.path, counts.get(h.value));
    if (!why) continue;
    h.synthetic = true;
    h.why = why;
    if (!reasons.includes(why)) reasons.push(why);
  }
  return reasons;
}

// ── inventory ────────────────────────────────────────────────────────

const pathOf = new Map();
for (const row of git('rev-list', '--all', '--objects').trim().split('\n')) {
  const sp = row.indexOf(' ');
  if (sp > 0) pathOf.set(row.slice(0, sp), row.slice(sp + 1));
}

const objects = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)')
  .trim().split('\n').map((r) => r.split(' '));

const blobs = objects.filter(([, t]) => t === 'blob').map(([sha]) => sha);

console.log(dim(`repository  ${REPO}`));
console.log(dim(`objects     ${objects.length}, of which ${blobs.length} blobs`));
console.log(dim(`commits     ${git('rev-list', '--all', '--count').trim()} across all refs`));

const findings = [];
let skipped = 0;

// A blob counts as "current" when it is the version of a file at some ref tip.
// Using the index instead would be wrong: an unstaged edit in the working tree
// makes a stale blob look current, and a staged one makes a good one look stale.
// For an audit of what was published, the refs are the truth.
const tipShas = new Set();
for (const ref of git('for-each-ref', '--format=%(refname)').trim().split('\n')) {
  if (!ref) continue;
  for (const row of git('ls-tree', '-r', ref).trim().split('\n')) {
    if (!row) continue;
    const parts = row.split(/\s+/);
    tipShas.add(`${parts[2]} ${parts.slice(3).join(' ')}`);
  }
}

for (const sha of blobs) {
  const text = git('cat-file', '-p', sha);
  if (text.includes('\u0000') || text.length > 4_000_000) { skipped += 1; continue; }
  const path = pathOf.get(sha) ?? null;
  const stillCurrent = path !== null && tipShas.has(`${sha} ${path}`);
  findings.push(...scan(
    text,
    path ? `${path}` : `unreachable blob ${sha.slice(0, 8)}`,
    path,
    stillCurrent,
  ));
}

for (const chunk of git('log', '--all', '--format=%H%x1f%B%x1e').split('\x1e')) {
  const t = chunk.trim();
  if (!t) continue;
  const nl = t.indexOf('\x1f');
  if (nl === -1) continue;
  const sha = t.slice(0, nl).trim();
  for (const h of scan(t.slice(nl + 1), `commit message ${sha.slice(0, 8)}`, null)) {
    h.synthetic = false;
    h.committed = true;
    findings.push(h);
  }
}

console.log(dim(`scanned ${blobs.length - skipped} text blobs, ${skipped} binary/oversized skipped\n`));

// ── the decisive check ───────────────────────────────────────────────
// Patterns guess at what a secret looks like. This asks the exact question: is
// the credential we are actually using present in the object store?

function auditLiveCredential() {
  const envPath = join(REPO, 'backend', '.env');
  if (!existsSync(envPath)) {
    console.log(dim('live credential  backend/.env absent, check skipped'));
    return null;
  }
  const line = readFileSync(envPath, 'utf8')
    .split('\n').find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) {
    console.log(dim('live credential  no DATABASE_URL in backend/.env, check skipped'));
    return null;
  }

  let parsed;
  try {
    parsed = new URL(line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''));
  } catch {
    console.log(dim('live credential  DATABASE_URL did not parse, check skipped'));
    return null;
  }

  // Held in memory, never printed, never written anywhere.
  const password = decodeURIComponent(parsed.password);
  if (password.length < 8) {
    console.log(dim('live credential  password too short to search for, check skipped'));
    return null;
  }
  const needles = [...new Set([password, encodeURIComponent(password), line.slice(line.indexOf('=') + 1).trim()])];

  const leaks = [];
  for (const sha of blobs) {
    const text = git('cat-file', '-p', sha);
    if (text.includes('\u0000')) continue;
    if (needles.some((n) => n.length >= 8 && text.includes(n))) {
      leaks.push(pathOf.get(sha) ?? `unreachable blob ${sha.slice(0, 8)}`);
    }
  }
  const inMessages = git('log', '--all', '--format=%B')
    .split('\n').some((l) => needles.some((n) => n.length >= 8 && l.includes(n)));

  console.log(`live credential  user=${parsed.username} passwordLen=${password.length} `
    + `${/neon/.test(parsed.hostname) ? '(Neon)' : '(other host)'}`);
  console.log(`live credential  in a blob: ${leaks.length ? red(`YES, ${leaks.length} object(s)`) : green('no')} `
    + `in a commit message: ${inMessages ? red('YES') : green('no')}`);
  for (const l of leaks) console.log(red(`                 ${l}`));

  return leaks.length + (inMessages ? 1 : 0);
}

const liveLeaks = auditLiveCredential();

// ── report ───────────────────────────────────────────────────────────

const fixtureReasons = classifyAssignments(findings);

const actionable = findings.filter((f) => !f.synthetic && f.committed);
const unreachable = findings.filter((f) => !f.synthetic && !f.committed);
const synthetic = findings.filter((f) => f.synthetic);

const byWhat = (list) => {
  const m = new Map();
  for (const f of list) {
    if (!m.has(f.what)) m.set(f.what, []);
    m.get(f.what).push(f);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
};

console.log(`\n${'='.repeat(78)}`);

if (actionable.length) {
  console.log(red(`COMMITTED and not a known template — ${actionable.length} finding(s)`));
  console.log('='.repeat(78));
  for (const [what, list] of byWhat(actionable)) {
    console.log(`\n  [${list.length}] ${what}`);
    for (const f of list.slice(0, 10)) {
      const when = f.current ? 'current' : 'older revision';
      console.log(`      ${f.where}:${f.line}  ${f.info}  [${when}]`);
    }
    if (list.length > 10) console.log(dim(`      ... and ${list.length - 10} more`));
  }
} else {
  console.log(green('No secrets found in any committed file.'));
}

if (unreachable.length) {
  console.log(`\n${'-'.repeat(78)}`);
  console.log(yellow(`UNREACHABLE — ${unreachable.length} finding(s) in objects no ref points to`));
  console.log(dim('  Harmless locally and never pushed, but they persist in every clone'));
  console.log(dim('  until garbage collected. Remove them with:'));
  console.log(dim('    git reflog expire --expire=now --all && git gc --prune=now'));
  for (const [what, list] of byWhat(unreachable)) {
    console.log(`\n  [${list.length}] ${what}`);
    for (const f of list.slice(0, 8)) console.log(`      ${f.where}:${f.line}  ${f.info}`);
    if (list.length > 8) console.log(dim(`      ... and ${list.length - 8} more`));
  }
}

if (synthetic.length) {
  console.log(`\n${'-'.repeat(78)}`);
  console.log(dim(`${synthetic.length} finding(s) classified as expected — not secrets.`));
  const kinds = [...new Set(synthetic.map((f) => f.what))];
  for (const k of kinds) console.log(dim(`  ${k}`));
  if (fixtureReasons.length) {
    console.log(dim('\n  Password-shaped literals dismissed as test fixtures. Each met both'));
    console.log(dim('  conditions: the file is a test, and the literal uses at most two character'));
    console.log(dim('  classes. A real secret in a test file would still be reported above.'));
    for (const r of fixtureReasons) console.log(dim(`    - ${r}`));
  }
}

console.log(`\n${'='.repeat(78)}`);

const bad = (liveLeaks ?? 0) + actionable.length;
if (bad > 0) {
  console.log(red(`${bad} item(s) need attention. A committed secret cannot be fixed by editing the file:`));
  console.log('rotate the credential first, then rewrite history, then force-push.');
  console.log('See the rotation note in AGENTS.md.');
  process.exit(1);
}
if (unreachable.length) {
  console.log(yellow('No committed secrets. Unreachable objects can be cleared with git gc.'));
  process.exit(1);
}
console.log(green('Nothing to rotate.'));
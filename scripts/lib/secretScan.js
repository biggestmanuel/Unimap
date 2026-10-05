/**
 * Credential scanning rules.
 *
 * Separate from `verify.js` so the rules can be tested directly. A copy of a
 * security rule inside its own test is worse than no test: it passes while the
 * real rule is broken, which is exactly what happened here -- the scanner
 * exempted any value containing the substring "example", so AWS's own
 * documented example key id was invisible, and so would be any password with
 * "example" in it. `verify.js` check 8 exercises these functions themselves.
 */

/**
 * A Postgres URL with an inline password. Captures the host, so the rule can
 * tell a leaked production credential from the localhost compose default.
 *
 * The host is either a bracketed IPv6 literal or a bare name. The bare class
 * excludes quotes and backticks as well as whitespace, slashes and colons:
 * connection strings turn up in prose wrapped in any of them, and without those
 * exclusions `postgres://u:p@localhost` inside backticks captures the host as
 * "localhost`" and stops matching the local exemption.
 */
export const PG_URL_RE = /\bpostgres(?:ql)?:\/\/[^:]+:[^@{\s]+@(\[[^\]\s]+\]|[^\s/:'"`]+)/;

export const SECRET_PATTERNS = [
  [PG_URL_RE, 'a Postgres URL with an inline password'],
  [/\bnpg_[A-Za-z0-9]{20,}/, 'a Neon API key or password'],
  [/\bneondb_owner\b/, 'the Neon owner role name'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  // Stripe uses an underscore. The hyphen form is kept because other providers
  // use it, but matching only the hyphen missed every real Stripe key.
  [/\bsk[-_][A-Za-z0-9]{32,}/, 'a Stripe-style secret key'],
];

export const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|host\.docker\.internal|\[::1\])$/i;

/**
 * True when a match is a placeholder rather than a real value.
 *
 * The placeholder word must stand alone. An earlier version tested for
 * "example" anywhere in the match, which quietly exempted AWS's own documented
 * example key id -- and would have exempted any real password containing that
 * word. A rule that can be switched off by a substring is not a rule.
 *
 * The literal that exposed this lives in `secretScan.probes.json`, which is
 * exempt from the scan. Naming it here would defeat the point of that.
 */
export function isPlaceholderValue(sample) {
  if (/<\.\.\.>/.test(sample)) return true;
  return /(?:^|[^A-Za-z0-9])(your|placeholder|changeme|example|xxx|dummy|sample)(?:[^A-Za-z0-9]|$)/i
    .test(sample);
}

/**
 * True when a match points at this machine rather than a real server.
 *
 * `postgres://unimap:unimap_dev@localhost` is the docker-compose default, and
 * the repository quotes it in prose explaining this very rule. Without the
 * exemption the scanner flags its own documentation and `npm run check` can
 * never pass -- which is worse than useless, because a permanently red check
 * gets ignored, and then it misses a real credential.
 */
export function isLocalMatch(m) {
  // Only the Postgres rule captures a host, so an undefined group is simply
  // "this rule has no notion of where it points".
  return m[1] !== undefined && LOCAL_HOST_RE.test(m[1]);
}

/**
 * Files whose contents are exempt from the scan.
 *
 * The probes file has to contain things that look like credentials in order to
 * prove the scanner catches them, and `docs/SECURITY.md` quotes a redacted URL
 * while explaining the policy. Both are exempt wholesale rather than by a
 * per-line marker, because a marker can be sprinkled anywhere and a whole file
 * is something a reviewer reads with suspicion.
 */
const EXEMPT_FILES = new Set([
  'backend/.env.example',
  'scripts/lib/secretScan.probes.json',
]);

export function isExemptFile(file) {
  return EXEMPT_FILES.has(file) || file.endsWith('docs/SECURITY.md');
}

/**
 * Every secret found in `text`, as `{ what, sample }`.
 *
 * Returns all of them rather than the first, so one file can report more than
 * one problem and fixing them one at a time is not a game of whack-a-mole.
 */
export function findSecrets(text, file = '') {
  if (isExemptFile(file)) return [];

  const found = [];
  for (const [re, what] of SECRET_PATTERNS) {
    // `matchAll` requires a global regex and these patterns are not global, so
    // clone with /g. That way every occurrence in the file is reported rather
    // than just the first.
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(global)) {
      if (isPlaceholderValue(m[0])) continue;
      if (isLocalMatch(m)) continue;
      found.push({ what, sample: m[0] });
    }
  }
  return found;
}

# AGENTS.md

Working notes for coding agents on this repository. Read this before changing
anything.

If a rule here conflicts with a habit you have, the habit is wrong. Every item
below cost real debugging time.

---

## The shell is PowerShell. It is not bash.

This is the single most expensive mistake available here. PowerShell has been
installed over bash in this environment, and pasting bash into it fails in ways
that look like application bugs.

| You want | Do NOT paste | Instead |
|---|---|---|
| `cmd1 && cmd2` | works only incidentally | put them on separate lines |
| `cat > f <<'EOF'` | parse error | use the **write** tool |
| `grep -q x f` | not a thing | `Select-String -Path f -Pattern x` |
| `rm -f f` | parse error | `Remove-Item f -Force` |
| `export X=1` | silently sets nothing useful | `$env:X = "1"` |
| `VAR=value cmd` | sets nothing | `$env:VAR = "value"; cmd` |

**`$1`, `$2` in SQL passed through a shell are eaten.** PowerShell interpolates
them away. `'SELECT ... WHERE x = $1'` becomes `WHERE x = ` and Postgres says
`function lower() does not exist` — a genuinely baffling error. **Put anything
containing `$1` in a script file and run that**, never inline.

Verify an assumption before trusting it. Several times a command reported success
while doing nothing at all:

```powershell
Write-Output ("len=" + $x.Length)   # confirms $x is actually set
```

## Ports

| What | Port |
|---|---|
| Backend API | 4000 |
| Frontend dev server | **5199** |

`5199` is deliberate and load-bearing. `playwright.config.js` uses
`reuseExistingServer: false` because several projects on this machine default to
**5173**, and with reuse enabled this suite silently ran against a different
application. A test passing against the wrong app is worse than a failing test.
Do not "fix" the port to 5173.

## Never paste or log a credential

Connection strings and passwords have appeared in scrollback during this project
and had to be rotated afterwards.

- Read secrets from `backend/.env` (gitignored) and export them in-process.
- **Never** print a URL, password, or token. Print derived facts instead:
  length, hostname, whether a column exists.
- A password typed in chat is compromised. Say so and offer rotation.
- Prefer prompting over a `--password` flag: the prompt keeps it out of shell
  history and out of this transcript.

The backend has **no dotenv dependency**. Every command needing `DATABASE_URL`
must export it first:

```powershell
$env:DATABASE_URL = ((Get-Content .env -Raw) -split "`n" |
  Where-Object { $_ -match '^\s*DATABASE_URL=' }) -replace '^\s*DATABASE_URL=',''
```

Git Bash: `export DATABASE_URL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)`

## `DATABASE_URL` is a direct connection, not pooled

PgBouncer breaks the `BEGIN`/`COMMIT` and `CREATE EXTENSION` that migrations
rely on. `channel_binding=require` does work with the installed `pg`, and the
`sslmode=require` → `verify-full` upgrade warning is noise, not a problem.

## Memory repository tests do not test Postgres

Every backend test runs against `createMemoryRepo`. The two repositories are
separate files with nothing comparing them, and they **have** diverged: it cost
a long debugging session to find that `postgresRepo` returned raw snake_case
rows while `resolveUser` read camelCase, so every login 401'd against the real
database while 289 tests passed green.

Anything touching row shape needs `backend/test/repoContract.test.js`-style
coverage, or a manual run against Neon.

## Do not trust a passing test that ran against nothing

Every one of these produced a green result while testing stale or wrong state:

- A `Start-Process` whose handle was `null`, so `Stop-Process` silently failed
  and the **old** process answered the next request. Symptom: a fix appeared to
  do nothing, because the old code was still serving.
- Playwright with a reused dev server (see the port note above).
- A test reading a graph cached from before the row was deleted.

Before believing a result, confirm **which process** answered and **when** it
started.

## Route paths must be checked against the router

`/corrections` and `/admin/corrections` both sound right. Only one exists. This
produced a 404 that shipped and sat in the console unnoticed. When adding or
calling an admin route, grep the route table in `backend/src/routes/`.

## Migrations

`schema.sql` runs whole, inside a transaction, on every `npm run migrate`.
Adding a column to an existing `CREATE TABLE IF NOT EXISTS` block does nothing
for a database that already has it — use a separate
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Both are idempotent, so re-running is
safe.

## Graph invariants worth keeping

- **Never mutate the rows** passed to `buildGraph`. `assembleGraph` reuses them
  for stats; a router that rewrites them corrupts the report.
- `deadEndCount` counts **link degree**, not way endpoints. Counting endpoints
  reported 344 dead ends across 323 ways, which is impossible. Any change here
  must keep `analyseConnectivity` and `buildGraph` agreeing — there are tests
  asserting exactly that.
- Merged traces become `footpath`, never `corridor`, and endpoints are snapped
  within 25 m. The middle of the walk is never moved.

## Before committing

```bash
npm run check
```

From the repo root. It runs eight checks, each corresponding to a mistake that
actually happened here:

| # | Check | Catches |
|---|---|---|
| 1 | Credentials in tracked files | A connection string or password committed |
| 2 | `.env` handling | `.env` tracked, ignored-but-unignored, or a template with a real secret in it |
| 3 | e2e port consistency | The suite running against another project's dev server and reporting green |
| 4 | Shell scripts | Heredocs and missing shebangs in `.sh` files |
| 5 | README accuracy | Wrong port, missing `VITE_API_BASE`, a script that does not exist, a broken doc link |
| 6 | Scratch files | A `_debug.mjs` left committed |
| 7 | Walk graph present | A fresh clone that cannot route at all |
| 8 | Scanner self-test | The credential scanner quietly ceasing to detect anything |

It is cheap, needs no database, and exits non-zero on a blocking problem. **Run
it before you push, not after.**

`npm run check:live` is separate and does need the network. It talks to the
deployed API and site, and it is the only check that can catch a stale build, a
missing environment variable, or a database that was never migrated. Unit tests
run against `createMemoryRepo` and a mocked fetch; nothing else in this
repository can tell you what production is actually serving.

`npm run audit:history` is the third command, and it covers the one thing the
other two cannot. `npm run check` scans the files in the working tree. A
credential that was committed once and then deleted is invisible to it and fully
present in the object store, in every clone, and on the remote forever.

That audit found nothing real — but it took three rounds to get there, and each
round was a false positive I had to disprove rather than a secret I could act on:

- **34 "hardcoded secret assignment" hits** were all test fixtures. They are
  classified as such only when the file is a test **and** the literal uses at
  most two character classes. Both conditions, because whitelisting
  `backend/test/` wholesale would hide a real secret pasted into a test — and
  because a rule that switches itself off too easily is the bug that already bit
  check 1 twice.
- **Four AWS key ids and one Postgres URL** were in *unreachable* objects left by
  my own scanner test earlier that day, which `git add`-ed a fake credential and
  then removed it. Never committed, never pushed, but persistent in `.git` until
  `git gc --prune=now`. **Never test a secret scanner by committing a fake
  secret**: if that were ever run during a real incident, it would commit the
  very thing being protected.
- **One "secret" was `password: 'wrong-password'`** in my own live smoke test, a
  value whose purpose is to be rejected. `wrong` and `bogus` are now recognised
  as placeholder words, with probes pinning that `myworship7` is still caught.

The most valuable part is not the pattern list. It is the check that takes the
live password out of `backend/.env` and searches every object for that literal.
Patterns guess at what a secret looks like; that asks the actual question. It
holds the value in memory, prints only a yes/no, and is the only assertion that
can say *nothing to rotate* with confidence.

Run it before making a repository public, before sharing a clone, and after any
suspected exposure. It takes about 50 seconds, which is why it is not part of
`npm run check`.

## A check that cannot fail is worse than no check

`npm run check` was **red for its entire existence** and was reported green
anyway. Two reasons, both worth remembering:

- It flagged its own documentation. Check 1 scans every tracked source file,
  including `scripts/verify.js`, whose comment quotes the localhost compose
  default. The localhost exemption existed in check 2 and had never been
  applied to check 1.
- Nobody ran it. A check that is permanently red stops being read, and then it
  catches nothing at all.

While fixing that, three more real defects surfaced in the scanner itself:

- **The placeholder exemption matched a substring.** `/example/i` anywhere in a
  value exempted AWS's own documented example key id — and any real password
  containing "example". A rule defeatable by a substring is not a rule. The
  placeholder word must stand alone.
- **The Stripe pattern used a hyphen.** Real Stripe keys use `sk_`, so it had
  never matched one.
- **The IPv6 loopback exemption was dead code.** The host character class
  excluded `:`, so `[::1]` could never be captured.

None of these were visible while the check was red for an unrelated reason.
That is check 8: it feeds 20 probe strings through the real rules, so the
scanner is now known to detect what it claims to detect. Adding an escape hatch
means adding a test for the thing it escapes.

**Never write a realistic secret in a comment.** Two of the false positives in
the history audit were `scripts/verify.js` and `scripts/auditHistory.js`
documenting the scanner in prose that quoted an example in the exact shape the
scanner looks for. Both were correct detections. The instinct to illustrate with
a concrete example is what puts them there — describe the shape instead, and put
any literal you truly need in the exempt probes file.

## Fixing a bug, measure it

The router snapped each end of a route to the single nearest piece of geometry.
With 42 islands on campus, the nearest is often a driveway, so both ends landed
in different components and the answer was a straight line drawn through a
building while a real path stood 25 m away.

Widening the snap to several candidates fixed it, and cost **+320% per routed
request** at three candidates. Two candidates cost **+59%** and produced
identical answers. The lesson is the boring one: measure the cost of a fix on
real data, do not guess, and if the expensive option buys nothing, do not take
it.

The same change then needed component labels so a doomed search could be skipped
before it ran. Without them, a fallback cost ~200 ms; with them, microseconds.
"Cheap" and "expensive" here were a 200 ms difference on a user-facing request,
and neither number was visible without running the real 1520-segment graph.

## The mistakes in this file were all avoidable

Worth being blunt about the pattern, because it repeats:

- Every shell error was PowerShell-not-bash. Check the shell before writing the
  command, not after it fails.
- Every "the fix did nothing" moment was stale state — an old process, a cached
  graph, a reused dev server, an un-redeployed Render build. Before believing a
  surprising result, ask *what actually answered*.
- Every security problem here was a secret that got printed, logged, or pasted
  when a derived fact (a length, a hostname, a boolean) would have done.
- Documentation in `AGENTS.md` is advice. `npm run check` is enforcement. Trust
  the second one — and if the second one is red, fix it before trusting
  anything else.
- A green test suite proves the tests describe current behaviour. It says
  nothing about whether they describe *correct* behaviour, and it never proves
  what is deployed.
- A red suite is not automatically a bug either. Five AdminApp tests failed once
  with `Test timed out in 5000ms` and **zero** assertion failures, on a machine
  busy with something else; the same file passed 24/24 unloaded minutes later.
  The tells were the failure type and the inflated timings — `setup` up 1.5x,
  `environment` up 4x. Distinguish "the assertion is wrong" from "the machine
  was too slow" before changing any code.

## Do not delete or overwrite work you did not write

Investigate before removing anything unfamiliar. If a test fails for a reason
that does not match its name, suspect the test before the code — several of the
best finds in this project were broken assertions, not broken features.
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
cd backend && npm run check
```

Or `node scripts/verify.js` from the repo root. It runs seven checks, each
corresponding to a mistake that actually happened here:

| # | Check | Catches |
|---|---|---|
| 1 | Credentials in tracked files | A connection string or password committed |
| 2 | `.env` handling | `.env` tracked, ignored-but-unignored, or a template with a real secret in it |
| 3 | e2e port consistency | The suite running against another project's dev server and reporting green |
| 4 | Shell scripts | Heredocs and missing shebangs in `.sh` files |
| 5 | README accuracy | Wrong port, missing `VITE_API_BASE`, a script that does not exist, a broken doc link |
| 6 | Scratch files | A `_debug.mjs` left committed |
| 7 | Walk graph present | A fresh clone that cannot route at all |

It is cheap, needs no database, and exits non-zero on a blocking problem. **Run
it before you push, not after.**

## The mistakes in this file were all avoidable

Worth being blunt about the pattern, because it repeats:

- Every shell error was PowerShell-not-bash. Check the shell before writing the
  command, not after it fails.
- Every "the fix did nothing" moment was stale state — an old process, a cached
  graph, a reused dev server. Before believing a surprising result, ask *what
  actually answered*.
- Every security problem here was a secret that got printed, logged, or pasted
  when a derived fact (a length, a hostname, a boolean) would have done.
- Documentation in `AGENTS.md` is advice. `npm run check` is enforcement. Trust
  the second one.

## Do not delete or overwrite work you did not write

Investigate before removing anything unfamiliar. If a test fails for a reason
that does not match its name, suspect the test before the code — several of the
best finds in this project were broken assertions, not broken features.
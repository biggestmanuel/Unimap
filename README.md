# UniMap

Mobile-first campus navigation for **Rivers State University**. Search a
building, get walking directions, work offline.

```
Unimap/
  frontend/   React + Vite PWA (the product)
  backend/    Express API, PostGIS, walk graph, corrections + moderation
  legacy/     Pre-React vanilla build, kept as a reference only
  docs/       Security notes, map tile policy
  scripts/    Repository-wide checks
  AGENTS.md   Conventions for anyone (human or agent) changing this repo
```

The root `package.json` exists only for repo-wide commands. `backend/` and
`frontend/` remain independent and keep their own lockfiles:

```bash
npm run check      # pre-commit checks, no database needed
npm run check:live # read-only checks against the deployed API and site
npm test           # both unit suites
```

## Quick start

```bash
# 1. Frontend
cd frontend
npm install
npm run dev            # http://localhost:5199

# 2. Backend — works in-memory if DATABASE_URL is unset
cd ../backend
npm install
npm run dev            # http://localhost:4000
```

Note the dev ports: the frontend runs on **5199**, not Vite's default 5173,
because the Playwright suite binds that port itself.

### Loading the database

```bash
cp .env.example .env      # then put your connection string in it
cd backend

# The backend has no dotenv dependency, so export the value first.
# Git Bash:
export DATABASE_URL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)
# PowerShell:
$env:DATABASE_URL = ((Get-Content .env -Raw) -split "`n" |
  Where-Object { $_ -match '^\s*DATABASE_URL=' }) -replace '^\s*DATABASE_URL=',''

npm run migrate           # schema; safe to re-run
npm run seed              # 79 POIs
npm run graph:import -- --from=../frontend/public/data/walk-graph.json
npm run graph:verify      # route real POI pairs and print the results
npm run graph:gaps        # what still needs tracing, with coordinates

# Bootstrap an admin. Prompts for the password, so it stays out of shell
# history. Re-running resets the password and role.
npm run user -- --email you@rsu.edu.ng --role admin
```

Routing is **in-process** — A* over `graph_edges`. There is no external routing
service to run. With no database, the API routes from
`frontend/public/data/walk-graph.json` instead, so a fresh clone still works.

`npm run graph:import -- --from=<path>` re-imports from a saved extract, which
is usually necessary because the Overpass mirrors rate-limit aggressively.

## Deployment

The app is deployed. This is the configuration, so it can be redeployed.

### Backend — Render

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Build Command | `npm install` (or blank — the Node builder installs automatically) |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Region | Frankfurt, to match a `eu-central-1` database |

Environment:

```
DATABASE_URL=<a DIRECT connection string, not the pooled one>
TRUST_PROXY=1
```

`TRUST_PROXY` matters: without it every client shares one rate-limit bucket, so
one busy campus can lock out everyone.

**After every deploy, check that it actually landed:**

```bash
curl -s https://unimap-wvvk.onrender.com/health
```

`commit` is the git SHA the live process is running. If it does not match
`git rev-parse HEAD`, Render has not finished deploying. This is worth doing —
a fix that "has no effect" on the live site is almost always an old build still
serving, not a broken fix.

**Use the direct connection, not the pooled one.** PgBouncer can break the
`BEGIN`/`COMMIT` and `CREATE EXTENSION` that migrations rely on.

### Frontend — Vercel

| Setting | Value |
|---|---|
| Root Directory | `frontend` |
| Framework Preset | Vite |
| Build / Output / Install | leave all three **off** — the preset defaults are already correct |
| Output Directory | `dist` |

Environment:

```
VITE_API_BASE=https://<your-render-host>/api
```

**This is the one variable that must be set**, applied to all environments. It
is baked into the bundle at build time. Without it every request goes to `/api`
on the Vercel domain and 404s: the map renders, nothing loads, and there is no
obvious error.

A custom domain needs no rebuild — `VITE_API_BASE` points at the API, not at
your own site.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Restructure, tooling, test harness | done |
| 1 | Map, POI markers, search, category filters, chips | done |
| 2 | Routing, GPS, geofence, arrival, theme | done |
| 3 | Offline PWA, install prompt, correction queue | done |
| 4 | Walk graph from OSM, validation, student traces | done |
| 5 | Auth, admin console, correction UI | done |
| 6 | Icons, XSS audit, e2e coverage | done |
| 7 | Trace merge, account revocation | done |

## If you are an agent or a new contributor

Read [`AGENTS.md`](./AGENTS.md) first. It records the conventions this repo
depends on and the specific mistakes it has already made — the shell here is
PowerShell, not bash; the dev port is 5199 for a reason; `.env` holds a live
credential. Then run `npm run check`, which mechanically enforces the parts you
can forget.

The tests are the other half. `npm test` must be green before anything is
pushed, and a test that fails for a reason that does not match its name is
usually the bug: several of the best finds here were broken assertions rather
than broken features.

## Tests

```bash
npm run check          # from the root: credentials, ports, docs, scratch files
npm run check:live     # against the deployed API and site (needs network)

cd frontend
npm test               # 192 unit + component tests (Vitest)
npm run test:e2e       # 46 end-to-end tests (Playwright, mobile + desktop)

cd ../backend
npm test               # 307 tests (node:test + supertest)
```

`npm run check` is worth running before every push. It exits non-zero on a
problem, and each check corresponds to a mistake that actually happened here —
see [`AGENTS.md`](./AGENTS.md).

`npm run check:live` is the only thing here that can tell you what production is
actually serving. It is read-only, safe to run at any time, and it compares the
commit reported by `/health` against your local `HEAD` so a deploy that did not
land is obvious instead of inferred from a symptom.

The frontend suite includes **data integrity tests** that read the real
`unimap.geojson` and assert every POI has a unique name, a valid category,
coordinates inside the campus boundary, and that all "popular place" chips
resolve. Those catch the class of bug that made the legacy chips silently dead.

**Every backend test runs against an in-memory double, never Postgres.** That is
a real gap, not an oversight: it is how `postgresRepo` came to return raw
snake_case rows while `resolveUser` read camelCase, so every login 401'd against
a real database while the whole suite stayed green. Two things now guard it —
`test/repoContract.test.js` pins the Postgres repository's output shapes through
a fake pool, and `test/postgresRepoSession.test.js` fails if the repository
stops using the row mapper.

## Architecture notes

**The Leaflet map is imperative.** React owns the UI chrome; the map instance
and its markers live in refs and are mutated directly. Category filtering
changes marker opacity without rebuilding anything, and the user marker moves
the same way — GPS fires about once a second and re-rendering the POI layer
with it would be wasteful.

**The walk graph is built per-vertex, not per-way.** This is the single most
important thing to know about the router. OSM splits roads into many short
ways, and a branch often meets a way at a vertex that is *interior* to that
way. Building the graph only at way endpoints fragments the campus network into
240 disconnected pieces, and every route silently falls back to a straight
line. Connectivity is decided by shared coordinates.

`buildGraph` also splits a way where another way's vertex lands on its
**interior**, which OSM data never needs and merged walk traces always do. Ways
that merely cross, with neither ending at the crossing, are an overpass and are
deliberately left unjoined.

**The closest geometry is not always the right geometry.** The campus has 42
islands — a driveway, a footpath that never met the network — so the nearest
thing to where you are standing is sometimes not connected to anything. Snapping
to it and nothing else meant a student near an island got a straight line drawn
through a building while a real path stood 25 m away. Each end of a route now
considers its `SNAP_CANDIDATES` nearest positions and the cheapest total wins,
off-network legs included, so a farther snap can never win by making you walk
further. `buildGraph` labels connected components up front, which is what keeps
a hopeless request costing microseconds instead of exhausting a search.

**A straight line is never presented as a route.** When no graph path exists
the API returns `found: false` with a reason, and the UI draws a dashed line
with a message. A slightly wrong direction beats a dead end, but a confident
lie is worse than both.

**A footpath is a shortcut, not a backbone.** `corridor` is the mapped road
network; `footpath` is a shortcut that only helps if the graph can get you back
onto a corridor from wherever it ends. A merged trace becomes a footpath, so a
recorded path that never meets the network stays inert rather than inventing
routes.

**OSRM was dropped on purpose.** A 2 km campus does not need a country-wide
routing container, and an in-process A* is the only version that keeps working
with no network — which the offline PWA requires. (The compose service was
also extracting with the *car* profile, which would have been wrong anyway.)

**Corrections are proposals; walk traces can become geometry.** A correction
never touches campus data until an admin approves it. A trace is different:
`POST /api/traces/:id/merge` writes a real `graph_edges` row, because the point
of recording a walk is to improve the map.

**Merged trace endpoints are snapped onto the network.** A person walking with a
phone does not stop on a surveyed vertex — GPS error alone is several metres —
so an unsnapped recording misses every node and becomes another island. The map
would look improved and nothing would have become routable. Only the two ends
are snapped, within 25 m, and the distance moved is returned so a suspicious
merge is visible. The middle of the walk is never moved: that part is the new
information.

**The graph is also split where another way's vertex lands mid-segment.** OSM
always splits a road at a shared node, so this changes nothing for imported data
— the campus extract has zero interior junctions. It matters for geometry that
did not come from OSM, such as a merged trace: without it, a branch ending
partway along a road is invisible to the router. Two ways that merely *cross*,
with neither ending at the crossing, are an overpass and are deliberately left
alone.

**A bad merge can be undone.** `DELETE /api/admin/graph/edges/:id` removes a
trace-derived footpath and returns its trace to the review queue, in one
transaction. Imported OSM geometry returns 409 — it is shared truth, not a
moderation decision.

**Auth is real now.** scrypt password hashing, revocable server-side sessions
with only a token digest stored, and a role gate on every admin route. The
earlier "501 in production" placeholder only bit under `NODE_ENV=production`,
which meant development was wide open.

**The console authenticates with a bearer token, not the session cookie.** The
console is served from a different origin than the API, and a cross-site cookie
would need `SameSite=None` plus an exact-origin allowlist — after which the
browser sends it automatically, which is CSRF. A token in a header is attached
deliberately, so forgery is structurally impossible. The cost is that a reload
signs you out.

**The admin console is a separate build entry** and is excluded from the
service worker precache. Students never download the moderation UI.

**Moderation decisions record the reviewer from the session,** never from the
request body. An admin can otherwise attribute a decision to a colleague, or to
an address that has never signed in — and the audit log exists to make that
impossible.

## Attribution

The campus walk graph, the map tiles and the campus boundary polygon are all
derived from **OpenStreetMap**, which is licensed under the
[Open Database License (ODbL)](https://www.openstreetmap.org/copyright).

- `frontend/public/data/walk-graph.json` is generated from OSM ways by
  `npm run graph:import` and is committed so a fresh clone works without a
  database. It is **derived data, not hand-authored** — regenerate it rather
  than editing it, and re-commit when the upstream data changes.
- Attribution is displayed in the map's tile layer and must stay visible.
  The admin console is not a map and does not need it.

## Docs

- [`PLAN.md`](./PLAN.md) — backlog, phase status, and the bugs found along the way
- [`AGENTS.md`](./AGENTS.md) — **read before changing anything.** Shell, ports, credentials, and the mistakes this repo has already made
- [`docs/SECURITY.md`](./docs/SECURITY.md) — XSS rules, auth design, response headers
- [`docs/TILES.md`](./docs/TILES.md) — map tile policy, **needs a decision**
- [`OVERNIGHT-PLAN.md`](./OVERNIGHT-PLAN.md) — the review-gated work plan and its results

## Manual steps you still need to do

These need a person on campus, or a decision only you can make.

1. **Walk the campus and check the footpaths.** OSM's data is only as good as
   whoever mapped it. `npm run graph:gaps` prints the island coordinates; the
   cheapest gap is 46 m.
2. **Check the POIs that sit off the network.** A marker you cannot route to is
   worse than no marker.
3. **Field-test over real Glo data.** The offline path has never been tested
   with an actual satellite feed.
4. **Choose a tile source.** The public OSM tile server will rate-limit real
   campus traffic. See [`docs/TILES.md`](./docs/TILES.md).
5. **Verify the Neon password in the console.** The one in `.env` works, but
   confirm it is the current one.

Everything else in the "limitations" column has been fixed: interior junctions
are connected, expired sessions are swept hourly, the dead helpers are gone, CSP
headers are set, and a bad merge can be undone from the console.
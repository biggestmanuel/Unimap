# UniMap — Build Plan

Dependency-ordered. Magnitude: **S** hours · **M** days · **L** weeks.
Items marked ✅ are done.

---

## Phase 0 — Unblock ✅

- ✅ Restructure into `frontend/` + `backend/`, move vanilla app to `legacy/`
- ✅ Move `unimap.geojson` to `frontend/public/data/`
- ✅ Delete placeholder React code (hardcoded centre, fake route button)
- ✅ Vitest + Testing Library + Playwright + supertest harnesses
- ✅ Docker Compose for PostGIS (OSRM deliberately dropped — see Phase 2)
- ✅ PostGIS schema with `graph_edges` in place before any tracing starts

## Phase 1 — Core slice ✅

- ✅ Leaflet map with category-coloured `divIcon` markers
- ✅ Importer POI normalisation, defensive against malformed rows
- ✅ Search with ranked scoring
- ✅ Category filter chips, counted and sorted by population
- ✅ Popular-place chips, with **unresolved names reported** rather than silently dropped
- ✅ Popups, skeleton loader, error + retry state

## Phase 2 — Navigation parity ✅

- ✅ A* over the walk graph, built **per-vertex** from OSM (`backend/src/graph/router.js`)
  Per-vertex, not per-way: a branch often meets a way at a vertex interior to
  it, and building only at way endpoints fragmented the campus into 240 pieces.
- ✅ `POST /api/route` — accepts `{lat,lng}` or `{poiId}` at either end
- ✅ `GET /api/graph/stats` — connectivity, islands, dead ends, per-class totals
- ✅ Straight-line fallback, with the reason surfaced so the UI can label it
- ✅ **Each end of a route considers its two nearest positions**, not just the
  closest. With 42 islands on campus the nearest geometry is often a driveway
  connected to nothing, which made both ends snap into different components and
  returned a straight line through a building while a real path stood 25 m away.
  The cheapest total wins, off-network legs included. `buildGraph` labels
  connected components so a hopeless pairing is skipped rather than searched.
- ✅ GPS tracking via `watchPosition`, marker moved imperatively, accuracy circle
- ✅ Arrival detection (35 m) + off-route detection → "Re-route"
- ✅ Theme toggle, applied pre-paint to avoid a flash
- ✅ **Interior junctions are split.** `buildGraph` inserts a vertex where another
  way's vertex lands mid-segment. OSM already splits at shared nodes so the
  campus data is unchanged; merged walk traces now attach properly. Ways that
  merely *cross* are an overpass and are deliberately left alone.
- ⚠️ **OSRM dropped, deliberately.** RSU is ~2 km across; A* over ~1,500
  segments is instant in-process and, unlike a self-hosted OSRM container,
  keeps working with no network — which Phase 3 requires. The compose service
  was also extracting with the *car* profile, which would have been wrong.

## Phase 3 — Offline PWA ✅

- ✅ `vite-plugin-pwa` / Workbox — the legacy SW broke on Vite hashed assets
- ✅ IndexedDB cache (`lib/offlineCache.js`), network-first with cache fallback
- ✅ Queued corrections flushed on reconnect; offline submissions are kept
- ✅ `beforeinstallprompt` captured and surfaced
- ✅ iOS-friendly install tags; storage persistence requested where supported
- ✅ The Google Fonts link is gone — a render-blocking third-party request
  defeats offline use. System font stack instead.
- ⚠️ **Bundled tiles z16–19 not done, deliberately.** See `docs/TILES.md`: the
  3–8 MB estimate was wrong, and bulk-downloading the public OSM servers for a
  bundle violates their usage policy. Runtime caching (capped at 3,000 tiles)
  covers the real need.

## Phase 4 — Walk graph

- ✅ Overpass extraction of the existing OSM network (`backend/src/graph/overpass.js`)
  RSU is already mapped: **324 campus ways, 43.2 km corridor + 4.7 km footpath**
- ✅ Graph build pipeline: OSM → normalised JSON → PostGIS `graph_edges`
- ✅ Re-runnable importer (`npm run graph:import`) — trace more footpaths,
  re-run, done. Also writes `walk-graph.json` so routing works with no database
- ✅ Connectivity validation tooling: islands, dead ends, unreachable POIs
- ✅ **Student trace submission** (`POST /api/traces`): offered when the user
  is genuinely off the mapped network, sorted furthest-off-first for review
- ✅ **A reviewed trace becomes real geometry.** `POST /api/traces/:id/merge`
  writes a `graph_edges` row in one transaction with the status change. Geometry
  is Douglas-Peucker simplified first — `buildGraph` splits at every vertex, so
  raw GPS jitter would add thousands of routing nodes per trace.
- ✅ **Endpoints are snapped** onto the network within 25 m, distance recorded.
  A person walking does not stop on a surveyed vertex, so without this every
  genuine recording stranded itself as another island.
- ✅ **A bad merge can be undone.** `DELETE /api/admin/graph/edges/:id` removes a
  trace-derived footpath and returns its trace to the queue, atomically.
  Imported OSM geometry is refused — it is shared truth, not a moderation call.
- ⚠️ **Campus footpaths do NOT need hand-tracing.** 55 footway ways (4.7 km)
  are already mapped and 100% connected. What is needed is *verification*:
  - 41 islands — 4 need attention (32-way island + Eagle Island Road); the
    rest are single driveways
  - **102 dead-end nodes.** This was previously reported as 344, which is
    impossible across 323 ways: the metric counted way *endpoints* rather than
    link degree. It now agrees with the router's own adjacency by construction.
  - 7 POIs sit >30 m off the network (worst: Convo Arena Field, 67 m)
- [ ] Verify OSM footpaths match reality — **requires someone who has walked
  the campus**; imagery cannot show paths under tree cover
- [ ] The geofence rectangle is a crude bounding box, not the real campus
  boundary; it pulls in ~8 km of surrounding residential streets

## Phase 5 — Backend + admin ✅

- ✅ POI read API with PostGIS full-text search
- ✅ Corrections API: submit, list-own, moderation queue, approve/reject
- ✅ Transactional approval + audit log
- ✅ Zod validation at every boundary
- ✅ **Real auth + roles.** scrypt password hashing, revocable server-side
  sessions, role gate on every admin route. The old "501 in production"
  placeholder is gone — it only bit under `NODE_ENV=production`, which meant
  development was wide open.
- ✅ **The console authenticates with a bearer token, not the cookie.** It is
  served from a different origin than the API, and a cross-site cookie would
  need `SameSite=None` plus an exact-origin allowlist — after which the browser
  sends it automatically, which is CSRF. A token in a header is attached
  deliberately, so forgery is structurally impossible. Cost: a reload signs out.
- ✅ **Moderation records the reviewer from the session**, never the body.
- ✅ **Account revocation**: disable, revoke sessions, delete. Each guarded
  against self-targeting and against removing the last active admin.
- ✅ **Admin panel** (`/admin.html`) — separate Vite entry, excluded from the
  service worker precache so students never download it
- ✅ User-facing correction submission UI, works offline via the queue
- ✅ Bootstrap the first admin: `npm run user -- --email you@rsu.edu.ng --role admin`

## Phase 6 — Hardening ✅

- ✅ `logo.png` (1.4 MB) replaced by a generated icon set: 512/192/180/32/16
- ✅ XSS audit — no `innerHTML`, `dangerouslySetInnerHTML` or `eval` anywhere.
  Findings and the rules that keep it that way: `docs/SECURITY.md`
- ✅ Playwright coverage for navigation and app behaviour
- ✅ **Rate limiting** on the two public write endpoints (token bucket, 12 burst
  + 1/10 s refill), and `trust proxy` so a reverse proxy does not collapse
  every client into one bucket
- ✅ **Security headers** on every response including error paths. `nosniff`
  is the one that earns its place: without it a browser may treat a JSON error
  body as HTML, which is the only route from a POI name to script running here.
- ✅ **Expired sessions are swept hourly.** Retention, not security — an expired
  token already cannot authenticate — but the only other deletion was triggered
  by presenting one, which a dormant deployment never does.
- ✅ **Repository-wide checks** (`npm run check`) covering credentials, ports,
  docs accuracy and scratch files, plus `AGENTS.md` recording the conventions.
  Eight checks, the eighth proving the credential scanner still detects
  credentials — the scanner had quietly stopped matching Stripe keys and any
  password containing the word "example".
- ✅ **`npm run check:live`** — read-only checks against the deployed API and
  site. The only thing in the repository that can tell you what production is
  serving; it compares the commit from `/health` against local `HEAD` so a
  deploy that did not land is explicit rather than inferred from a symptom.
- ✅ **Deployed**: API on Render, frontend on Vercel, PostGIS 3.6 on Neon.
  `/health` reports the running commit so a stale deploy is obvious.
- ⚠️ **Tile policy still needs a decision** — `VITE_TILE_URL` is wired, so
  switching to a self-hosted TileServer is a config change. See `docs/TILES.md`
- [ ] Field test on real devices over Glo data (manual)

---

## Cannot be automated — you must do these

Everything below genuinely needs a human. Everything else is done, deployed, or
behind a command.

### 1. Check the footpaths against reality

The campus is already mapped in OSM — 55 footway ways, 4.7 km, 100% connected.
You are **not** drawing them. You are confirming they match what is there, and
finding the paths under tree canopy that satellite imagery cannot show.

`npm run graph:gaps` has already narrowed this down. Load relation
`10559059` in JOSM with Esri World Imagery and check the flagged items:

| POI | Off path | Verdict |
|---|---|---|
| Senior Staff Club RSU | 42 m | coordinate is right — a path is missing |
| New Marine Building | 38 m | coordinate is right — a path is missing |
| Basketball Court | 32 m | coordinate is right — a path is missing |
| Convo Arena Field | 67 m | **no building found — the coordinate is probably wrong** |
| Hostel A | 42 m | **no building found — check the coordinate** |
| PG field | 36 m | **no building found — check the coordinate** |
| Tennis Court | 30 m | **no building found — check the coordinate** |

### 2. Close the four islands

| Island | Gap to main network |
|---|---|
| 32 ways, 4.4 km (unnamed) | **46 m** — the cheapest, biggest win |
| Eagle Island Road, 622 m | 93 m |
| unnamed, 601 m | 237 m |
| unnamed, 344 m | 269 m |

Or record a walk with the app and merge it in the console, which now works
end to end.

### 3. Field test on your phone over Glo data

The go/no-go gate. Install from the prompt, ask for directions **while
offline**, report a problem while offline and reconnect, and record one walk.

### 4. Decide the tile source

`docs/TILES.md`. The code side is done — set `VITE_TILE_URL` and it switches.

### 5. Verify the Neon password

It was rotated during setup and the current one works, but confirm in the Neon
console that `.env` holds the live value.

---

## Bugs found and fixed by testing against real data

Recorded because each would have shipped silently, and each was caught by
running against live data or real HTTP rather than fixtures.

### The ones that mattered most

- **The router trusted a single snap per end.** The campus has 42 islands, so
  the nearest geometry to a given spot is often a driveway that is connected to
  nothing. Both ends then landed in different components and the response was a
  straight line drawn through a building — while a real path stood 25 m away.
  Each end now costs its two nearest positions and the cheapest total wins.
  Fixing it also required labelling connected components in `buildGraph`, so a
  request that cannot possibly succeed is skipped instead of exhausting a
  search: a fallback went from ~200 ms to microseconds.
- **`npm run check` was red for its entire existence and reported green.** It
  flagged its own documentation, because check 1 scans every tracked file and
  the localhost exemption had only ever been applied to check 2. Fixing that
  exposed three more real defects in the credential scanner itself: the
  placeholder exemption matched the substring "example" (so any password
  containing that word passed), the Stripe pattern used a hyphen instead of an
  underscore, and the IPv6 loopback exemption was unreachable. There is now a
  self-test feeding 17 probe strings through the real rules.
- **`postgresRepo` returned snake_case rows while the app read camelCase.** Every
  login 401'd against the real database while all 251 tests passed green, because
  every test injects the in-memory repo. `rowToSession` and a contract test now
  guard this.
- **The same divergence meant session expiry was never enforced** —
  `new Date(undefined)` is `NaN` and `NaN <= now` is false, so a leaked token
  stayed valid indefinitely.
- **`deadEndCount` counted way endpoints, not link degree.** Reported 344 dead
  ends across 323 ways, which is impossible.
- **Merged traces could never connect.** A trace had to land on an exact vertex;
  a person walking does not, so every genuine recording became another island.
- **The admin console read `reviewer` from the request body** while the route
  already knew who was signed in — the audit trail was forgeable.
- **The e2e cache helper raced the app's IndexedDB open**, creating an empty
  database so `onupgradeneeded` never fired and the app silently cached nothing.
  The suite failed about one run in three for this reason.
- **`/corrections` did not exist**; the moderation queue is `/admin/corrections`.
  Shipped and unnoticed because the tab was never opened in a test.
- **A mistyped password reported "not authenticated"**, telling someone their
  session had ended when they had simply got the password wrong.
- **Removing a merged edge could leave the trace stranded as `merged`** — the
  trace has to be found before the delete, because `merged_edge_id` is
  `ON DELETE SET NULL`.
- **"Is production running current code?" was unanswerable.** A fix was verified
  locally, pushed, and appeared to have no effect because the live site was on an
  older build. `/health` now reports the running commit and `npm run check:live`
  compares it against local `HEAD`.

### From earlier phases

- **Graph built at way endpoints instead of vertices**, fragmenting one 241-way
  network into **240 components**; every route fell back to a straight line.
- **Same-segment routes reported 0 m** — both snaps landing mid-way made A* skip
  all partial-edge cost.
- **`haversineMeters` returned degrees, not metres** in the first audit script.
- **An empty Overpass response was accepted as valid**, overwriting a working
  `walk-graph.json` with an empty one.
- **`meters: null` in `/api/graph/stats`** — edges were built without
  `lengthMeters`, so totals serialised as `NaN`.
- **`POST /api/admin/users` returned the password hash.** Every user-returning
  route now goes through `publicUser()`.
- **An oversized body returned 500, not 413**, telling a caller their malformed
  request was our outage.
- **Trace points read as objects when they are tuples**, so every trace was
  rejected as "does not move".
- **Selecting a POI offered no way to ask for directions** — the whole
  navigation feature was unreachable from the UI.
- **`remainingMeters` returned 0 at the start of a route.**

---

## Known issues found and fixed during Phase 1

- Source data had `"laboratory "` with a trailing space — now normalised.
- `RSU_CAMPUS_POLYGON` was not an explicitly closed ring.
- The legacy `POPULAR_PLACES` chips matched by exact string, so any drift in the
  geojson silently produced dead chips. Resolution is fuzzy and reports misses.
- `formatDistance(999)` returned `"1000 m"` — now switches to km.
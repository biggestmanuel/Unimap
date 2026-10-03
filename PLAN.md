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
- ✅ GPS tracking via `watchPosition`, marker moved imperatively, accuracy circle
- ✅ Arrival detection (35 m) + off-route detection → "Re-route"
- ✅ Theme toggle, applied pre-paint to avoid a flash
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
  RSU is already mapped: **324 campus ways, 43.7 km corridor + 4.7 km footpath**
- ✅ Graph build pipeline: OSM → normalised JSON → PostGIS `graph_edges`
- ✅ Re-runnable importer (`npm run graph:import`) — trace more footpaths,
  re-run, done. Also writes `walk-graph.json` so routing works with no database
- ✅ Connectivity validation tooling: islands, dead ends, unreachable POIs
- ✅ **Student trace submission** (`POST /api/traces`): offered when the user
  is genuinely off the mapped network, sorted furthest-off-first for review
- ⚠️ **Campus footpaths do NOT need hand-tracing.** 55 footway ways (4.7 km)
  are already mapped and 100% connected. What is needed is *verification*:
  - 41 islands — 4 need attention (32-way island + Eagle Island Road); the
    rest are single driveways
  - 346 dead-end nodes
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
  sessions, HttpOnly cookie, role gate on every admin route. The old
  "501 in production" placeholder is gone — it only bit under
  `NODE_ENV=production`, which meant development was wide open.
- ✅ **Admin panel** (`/admin.html`) — separate Vite entry, excluded from the
  service worker precache so students never download it
- ✅ User-facing correction submission UI, works offline via the queue
- ✅ Bootstrap the first admin: `npm run user -- --email you@rsu.edu.ng --role admin`

## Phase 6 — Hardening

- ✅ `logo.png` (1.4 MB) replaced by a generated icon set: 512/192/180/32/16
- ✅ XSS audit — no `innerHTML`, `dangerouslySetInnerHTML` or `eval` anywhere.
  Findings and the rules that keep it that way: `docs/SECURITY.md`
- ✅ Playwright coverage for navigation (12 specs: theme, geolocation, routing,
  fallback labelling, corrections, XSS payload)
- ✅ **Rate limiting** on the two public write endpoints (token bucket, 12 burst
  + 1/10 s refill), and `trust proxy` so a reverse proxy does not collapse
  every client into one bucket
- ✅ **Deployed**: PostGIS in Docker, schema applied, 79 POIs seeded, 323 graph
  edges imported, admin account bootstrapped
- ⚠️ **Tile policy still needs a decision** — `VITE_TILE_URL` is now wired, so
  switching to a self-hosted TileServer is a config change. See `docs/TILES.md`
- [ ] Field test on real devices over Glo data (manual)

---

## Cannot be automated — you must do these

Everything below genuinely needs a human. Everything else on this list is now
done, deployed, or automated behind a command.

### 1. Check the footpaths against reality

The campus is already mapped in OSM — 55 footway ways, 4.7 km, 100% connected.
You are **not** drawing them. You are confirming they match what is there, and
finding the paths under tree canopy that satellite imagery cannot show.

`npm run graph:gaps` has already narrowed this down for you. Load relation
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

`npm run graph:gaps` prints this table plus the exact gap coordinates for each
island, so nothing here is guesswork.

### 2. Close the four islands

Also from `npm run graph:gaps`, each with the two coordinates to join:

| Island | Gap to main network |
|---|---|
| 32 ways, 4.4 km (unnamed) | **46 m** — the cheapest, biggest win |
| Eagle Island Road, 622 m | 93 m |
| unnamed, 601 m | 237 m |
| unnamed, 344 m | 269 m |

The 46 m gap is the one that matters. Re-run `npm run graph:gaps` after
editing, then `npm run graph:import`, to see the effect.

### 3. Field test on your phone over Glo data

The go/no-go gate. Specifically:

- install from the prompt, confirm it opens standalone
- ask for directions **while offline** — the route should still draw
- report a problem while offline, reconnect, confirm it sends
- walk one of the "trace a path to it" locations and record a walk

### 4. Decide the tile source

`docs/TILES.md`. The code side is done — set `VITE_TILE_URL` and it switches.

### 5. Point this at real hosting

PostGIS runs locally. The API needs a host that terminates TLS, sets
`TRUST_PROXY`, and holds `DATABASE_URL` from `.env`. Nothing in the app
changes for that.

---

## Bugs found and fixed by testing against real data

Recorded because each one would have shipped silently, and each was only
caught by running against live OSM data or real HTTP rather than fixtures.

- **Graph built at way endpoints instead of vertices.** OSM branches routinely
  meet a way at a vertex interior to it. Building only at endpoints fragmented
  one 241-way network into **240 components**, and every single route fell back
  to a straight line. Fixed; there is now a test that pins the behaviour down.
- **Same-segment routes reported 0 m.** Both snaps landing mid-way on one way
  made A* hit `start === goal` and skip all partial-edge cost.
- **`haversineMeters` returned degrees, not metres**, in the first audit
  script — every length printed as `0 m`.
- **An empty Overpass response was accepted as valid**, and the importer then
  overwrote a working `walk-graph.json` with an empty one. Both fixed: an empty
  result is now a mirror failure, and the writer refuses to clobber.
- **`meters: null` in `/api/graph/stats`.** `assembleGraph` built edges without
  `lengthMeters`, so connectivity totals were `NaN` and serialised as `null`.
- **`POST /api/admin/users` returned the password hash.** Caught by its own
  test; every user-returning route now goes through `publicUser()`.
- **An oversized body returned 500, not 413**, because body-parser errors fell
  through the generic handler — telling a caller their malformed request was
  our outage.
- **Trace points read as objects when they are tuples**, so `p.lat` was
  `undefined` for every point and every trace was rejected as "does not move".
- **Selecting a POI offered no way to ask for directions** — the whole
  navigation feature was unreachable from the UI. Found by an e2e test.
- **`remainingMeters` returned 0 at the start of a route**, because the
  scan-forward loop broke on the very first vertex.

---

## Known issues found and fixed during Phase 1

- Source data had `"laboratory "` with a trailing space — now normalised
  at load.
- `RSU_CAMPUS_POLYGON` was not an explicitly closed ring.
- The legacy `POPULAR_PLACES` chips matched by exact string, so any drift
  in the geojson silently produced dead chips. Resolution is now fuzzy
  and reports misses; a test asserts all 15 resolve.
- `formatDistance(999)` returned `"1000 m"` — now switches to km.
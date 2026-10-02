# UniMap

Mobile-first campus navigation for **Rivers State University**. Search a
building, get walking directions, work offline.

```
Unimap/
  frontend/   React + Vite PWA (the product)
  backend/    Express API, PostGIS, walk graph, corrections + moderation
  legacy/     Pre-React vanilla build, kept as a reference only
  docs/       Security notes, map tile policy
```

## Quick start

```bash
# 1. Frontend
cd frontend
npm install
npm run dev            # http://localhost:5173

# 2. Backend — works in-memory if DATABASE_URL is unset
cd ../backend
npm install
npm run dev            # http://localhost:4000
```

For the real database:

```bash
cp .env.example .env
docker compose up -d   # PostGIS on 5433
cd backend
npm run migrate
npm run seed
npm run graph:import   # pull the campus walk graph from OpenStreetMap
npm run graph:verify   # route some real POI pairs and print the results

# Bootstrap the admin console at /admin.html
npm run user -- --email you@rsu.edu.ng --role admin
```

Routing is **in-process** — A* over `graph_edges`. There is no external routing
service to run. With no database, the API routes from
`frontend/public/data/walk-graph.json` instead, so a fresh clone still works.

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

## Tests

```bash
cd frontend
npm test               # 132 unit + component tests (Vitest)
npm run test:e2e       # 38 end-to-end tests (Playwright, mobile + desktop)

cd ../backend
npm test               # 149 tests (node:test + supertest)
```

The frontend suite includes **data integrity tests** that read the real
`unimap.geojson` and assert every POI has a unique name, a valid category,
coordinates inside the campus boundary, and that all 15 "popular place" chips
resolve. Those catch the class of bug that made the legacy chips silently dead.

## Architecture notes

**The Leaflet map is imperative.** React owns the UI chrome; the map instance
and its markers live in refs and are mutated directly. Category filtering
changes marker opacity without rebuilding anything, and the user marker moves
the same way — GPS fires about once a second and re-rendering the POI layer
with it would be wasteful.

**The walk graph is built per-vertex, not per-way.** This is the single most
important thing to know about the router. OSM splits roads into many short
ways, and a branch often meets a way at a vertex that is *interior* to that
way. Building the graph only at way endpoints fragments a 241-way campus
network into 240 disconnected pieces, and every route silently falls back to a
straight line. Connectivity is decided by shared coordinates.

**A straight line is never presented as a route.** When no graph path exists
the API returns `found: false` with a reason, and the UI draws a dashed line
with a message. A slightly wrong direction beats a dead end, but a confident
lie is worse than both.

**OSRM was dropped on purpose.** A 2 km campus does not need a country-wide
routing container, and an in-process A* is the only version that keeps working
with no network — which the offline PWA requires. (The compose service was
also extracting with the *car* profile, which would have been wrong anyway.)

**Corrections and walk traces never write to campus data directly.** Both land
as pending proposals. Only an admin decision applies them.

**Auth is real now.** scrypt password hashing, revocable server-side sessions
with only a token digest stored, HttpOnly cookies, and a role gate on every
admin route. The earlier "501 in production" placeholder only bit under
`NODE_ENV=production`, which meant development was wide open.

**The admin console is a separate build entry** and is excluded from the
service worker precache. Students never download the moderation UI.

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
- [`docs/SECURITY.md`](./docs/SECURITY.md) — XSS rules and auth design
- [`docs/TILES.md`](./docs/TILES.md) — map tile policy, **needs a decision**

## Manual steps you still need to do

See [`PLAN.md`](./PLAN.md) → "Cannot be automated". In short: walk the campus to
verify the OSM footpaths, fix the handful of POIs that sit off the network,
field-test over Glo data, decide the tile source, and put rate limiting in
front of the API.
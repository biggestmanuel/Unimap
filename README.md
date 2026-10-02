# UniMap

Mobile-first campus navigation for **Rivers State University**. Search a
building, get walking directions, work offline.

```
Unimap/
  frontend/   React + Vite app (the product)
  backend/    Express API, PostGIS, corrections + moderation
  legacy/     Pre-React vanilla build, kept as a reference only
```

## Quick start

```bash
# 1. Frontend (no backend needed for the map + search slice)
cd frontend
npm install
npm run dev            # http://localhost:5173

# 2. Backend — optional, in-memory if DATABASE_URL is unset
cd ../backend
npm install
npm run dev            # http://localhost:4000
```

For the real database:

```bash
cp .env.example .env
docker compose up -d   # PostGIS on 5433
cd backend && npm run migrate && npm run seed

# Build the walk graph from OpenStreetMap, then run it:
node src/graph/importOsm.js
node scripts/verifyCampusRouting.js   # routes real POI pairs
```

Routing is in-process (A* over `graph_edges`), so there is no external
routing service to run.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Restructure, tooling, test harness | done |
| 1 | Map, POI markers, search, category filters, chips | done |
| 2 | Routing, GPS, geofence, arrival, "I'm Lost" | next |
| 3 | Offline PWA, tile pack, install prompt | planned |
| 4 | Walk graph (corridors + footpaths) | planned |
| 5 | Admin panel, auth, moderation UI | planned |

## Tests

```bash
cd frontend
npm test               # 110 unit + component tests (Vitest)
npm run test:e2e       # 16 end-to-end tests (Playwright, mobile + desktop)

cd ../backend
npm test               # 55 tests (node:test + supertest)
```

The frontend suite includes **data integrity tests** that read the real
`unimap.geojson` and assert every POI has a unique name, a valid
category, coordinates inside the campus boundary, and that all 15
"popular place" chips resolve. Those catch the class of bug that made
the legacy chips silently dead.

## Architecture notes

**The Leaflet map is imperative.** React owns the UI chrome; the map
instance and its markers live in refs and are mutated directly. Category
filtering changes marker opacity without rebuilding anything. This is
what keeps the map smooth while GPS updates arrive several times a
second.

**Corrections never write to campus data directly.** A student submission
lands in `corrections` as a pending proposal. Only an admin approval
applies it, in a single transaction that also writes an audit row.

**Offline routing falls back to straight-line** until the walk graph is
built, so nothing is blocked on surveying campus paths.

## Manual steps you still need to do

See [`PLAN.md`](./PLAN.md) for the full backlog and the list of things
that cannot be automated.
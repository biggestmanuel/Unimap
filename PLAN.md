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

## Phase 2 — Navigation parity

- ✅ A* over the walk graph, built **per-vertex** from OSM (`backend/src/graph/router.js`)
- ✅ Straight-line fallback when no graph route exists
- ✅ POI / GPS position snapping to the nearest edge
- ✅ Turn-by-turn legs with named ways
- ⚠️ **OSRM dropped, deliberately.** RSU is ~2 km across; A* over ~1,500
  segments is instant in-process and, unlike a self-hosted OSRM container,
  keeps working with no network — which Phase 3 requires. `VITE_OSRM_BASE_URL`
  is no longer needed.
- [ ] Expose the router over HTTP (`POST /api/route`) — graph load + validation
- [ ] GPS tracking via `watchPosition`, moving the user marker imperatively (M)
- [ ] Arrival detection + "I'm Lost" (S)
- [ ] Theme toggle (S)
- ✅ `events.json` deleted (it was an empty stub)

## Phase 4 — Walk graph

- ✅ Overpass extraction of the existing OSM network (`backend/src/graph/overpass.js`)
  RSU is already mapped: **324 campus ways, 43.7 km corridor + 4.7 km footpath**
- ✅ Graph build pipeline: OSM → normalised JSON → PostGIS `graph_edges`
- ✅ Re-runnable importer (`node src/graph/importOsm.js`) — trace more footpaths,
  re-run, done
- ✅ Connectivity validation tooling: islands, dead ends, unreachable POIs
- ⚠️ **Campus footpaths do NOT need hand-tracing.** 55 footway ways (4.7 km)
  are already mapped and 100% connected. What is needed is *verification*:
  - 41 islands — 4 need attention (32-way island + Eagle Island Road); the
    rest are single driveways
  - 346 dead-end nodes
  - 7 POIs sit >30 m off the network (worst: Convo Arena Field, 67 m)
- [ ] Verify OSM footpaths match reality — **requires someone who has walked
  the campus**; imagery cannot show paths under tree cover
- [ ] Student trace submission — "you are not on any edge" prompt (M)
- [ ] The geofence rectangle is a crude bounding box, not the real campus
  boundary; it pulls in ~8 km of surrounding residential streets

## Phase 5 — Backend + admin

- ✅ POI read API with PostGIS full-text search (M)
- ✅ Corrections API: submit, list-own, moderation queue, approve/reject (M)
- ✅ Transactional approval + audit log (M)
- ✅ Zod validation at every boundary (S)
- [ ] Real auth + roles. Admin routes return **501 in production** until this lands (M)
- [ ] Admin panel UI — separate bundle, not in the student PWA payload (L)
- [ ] User-facing correction submission UI (M)

## Phase 6 — Hardening

- [ ] `logo.png` is 1.4 MB; needs an optimised icon set (S)
- [ ] XSS audit once student-submitted text renders (S)
- [ ] Playwright coverage for navigation once Phase 2 lands (M)
- [ ] Field test on real devices over Glo data (manual)
- [ ] OSM/Esri tile usage policy review before real traffic (S)

---

## Cannot be automated — you must do these

1. **Walk the campus and check the footpaths against OSM.** Not to draw them —
   they are already mapped — but to confirm OSM matches reality and to spot the
   paths under tree canopy that imagery cannot show. Load relation `10559059`
   in JOSM with Esri World Imagery. You do not need to be there; you need to
   remember where the covered walkways run.

2. **Close the 4 real gaps the tooling found**, in priority order:
   - `Convo Arena Field` sits 67 m off the network — either trace a path to it
     or correct its coordinate
   - the 32-way island (~4.4 km) is unreachable from the main network
   - `Eagle Island Road` is a separate island (622 m)
   - 7 POIs total sit beyond 30 m from any way

3. **Field test on your phone over Glo data.** Disable wifi, load the app,
   tap Engineering Block, confirm a marker appears and search works.
   This is the go/no-go gate for everything after it.

4. **Hand-verify the 79 seeded POI coordinates** before students file
   corrections against them. 72 are within 30 m of a real path, so most are
   fine; the 7 flagged above are not.

5. **Deploy PostGIS** and run `node src/graph/importOsm.js` to populate
   `graph_edges`. No OSRM container is needed — the router is in-process.

6. **Decide admin auth.** Right now `/api/admin/*` returns 501 under
   `NODE_ENV=production`, which is deliberate — it is closed rather than
   open.

---

## Known issues found and fixed during Phase 1

- Source data had `"laboratory "` with a trailing space — now normalised
  at load.
- `RSU_CAMPUS_POLYGON` was not an explicitly closed ring.
- The legacy `POPULAR_PLACES` chips matched by exact string, so any drift
  in the geojson silently produced dead chips. Resolution is now fuzzy
  and reports misses; a test asserts all 15 resolve.
- `formatDistance(999)` returned `"1000 m"` — now switches to km.
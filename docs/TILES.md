# Map tile policy

**Status: needs a decision before this app is used by more than a handful of
people.** This is the one unresolved legal/practical item in Phase 6.

## What the app does today

The map uses the **public OpenStreetMap standard tile servers**:

```
https://{a|b|c}.tile.openstreetmap.org/{z}/{x}/{y}.png
```

That is fine for development and light use. It is **not** fine as a permanent
answer, because:

- The [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  prohibits heavy or bulk use of the public servers.
- There is no SLA. A busy campus on a shared network will get blocked, and the
  failure looks like "the map is broken", not "we are over quota".
- `tile.openstreetmap.org` is explicitly **not** available for offline
  prefetching or bulk downloading.

The service worker caches up to **3,000 tiles** for 14 days
(`unimap-tiles` in `vite.config.js`). That cap exists for exactly this reason:
it bounds the request rate a single device can generate. On a 1.5 km campus at
z16–17 that is a reasonable working set and not more.

## Options

### 1. Self-host tiles (recommended)

Run your own tile server from an OSM extract of Rivers State:

- Generate a `.osm.pbf` for Nigeria or a tighter extract with
  [Planetiler](https://github.com/onthegomap/planetiler) or `osmium`.
- Serve with [TileServer GL](https://github.com/maptiler/tileserver-gl) or
  `martin` (Rust, fast, easy).

Cost: a few GB of disk and a small VPS. Benefit: no rate limits, guaranteed
offline availability, and it stays inside the OSM policy because you are not
using someone else's public server.

The app only needs a tile URL change in two places:

- `frontend/src/components/MapShell.jsx` — the `TileLayer` URL
- `frontend/vite.config.js` — the `runtimeCaching` `urlPattern`

Make it configurable via `VITE_TILE_URL` so switching does not need a code
change.

### 2. A commercial tile provider

MapTiler, Stadia, Thunderforest and similar all have free tiers for low volume.
Fastest route to production, at the cost of an API key in the client and a
usage bill. Note that offline caching a commercial provider's tiles usually
needs an explicit licence — check before bundling any into a PWA.

### 3. Keep the public OSM tiles, but keep the cap

Acceptable while the app is used by a class at a time. The risk is that the
usage is no longer "light" and the servers start refusing.

## Bundling tiles for true offline

Phase 3 lists "bundled raster tiles z16–19, roughly 3–8 MB" as **not done**.
This is deliberately left out rather than half-built:

- A z16–19 bundle over even a small campus is tens of megabytes, not 3–8 MB.
  The original estimate was wrong.
- Pre-bundling means committing binaries to the repository, which conflicts
  with the `.gitignore` rule that OSM data is never committed.
- Downloading the public OSM servers in bulk to package them **violates their
  usage policy**, regardless of intent.

The runtime cache gets most of the benefit: after one visit with signal, the
campus is usable offline. If a true guaranteed-offline bundle is wanted, it
should come from a self-hosted TileServer, which makes the licensing question
disappear.

## Attribution

Whatever is chosen, the attribution line in `MapShell.jsx` must stay accurate.
Self-hosted OSM tiles still require
`© OpenStreetMap contributors` attribution.
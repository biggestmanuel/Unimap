# UniMap

A mobile-first campus navigation web app for **Rivers State University (RSU)**. Search for a building or place on campus, drop a pin, and get walking directions with live GPS tracking — no app install required.

## Features

- Searchable directory of campus locations (buildings, hostels, faculties, banks, etc.), loaded from `unimap.geojson`
- Popular-places quick-select chips
- Live "you are here" tracking via the browser Geolocation API
- Turn-by-turn walking routes (via [OSRM](http://project-osrm.org/)) with a live distance/time readout
- "I'm Lost" — finds and highlights your nearest known landmark
- Automatic arrival detection
- Installable as a home-screen PWA (`site.webmanifest`)

## Running it locally

This is a static site — no build step required. Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. It won't work opened directly as a `file://` URL, since the browser needs to `fetch()` `unimap.geojson`.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell / markup |
| `unimap.css` | Styling (light blue / white theme) |
| `unimap.js` | Map logic, search, routing, geolocation |
| `unimap.geojson` | Campus location data (name + coordinates + optional description) |
| `site.webmanifest` | PWA metadata |

## Known limitations

- Routing uses the public OSRM demo server, which is rate-limited and not intended for production traffic — swap in a self-hosted OSRM instance (or another routing provider) before wider release.
- The offline banner reflects connectivity status only; map tiles are not actually cached for offline use.
- Location data (`unimap.geojson`) is community-sourced and may drift out of date as campus buildings change — PRs to correct names/coordinates are welcome.

## Adding a location

Add a new `Feature` to `unimap.geojson` with a `Name`, optional `description`, and `[longitude, latitude]` coordinates. To surface it as a quick-select chip, add its exact name to `POPULAR_PLACES` in `unimap.js` (and optionally a shorter label in `POPULAR_LABELS`).

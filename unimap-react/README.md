UniMap React scaffold

What this contains:
- Minimal Vite + React scaffold to start migrating Unimap into a component-driven app.
- MapShell (react-leaflet) and DirectionsPanel (scrollable fixed panel) example components.

How to run locally (after installing Node.js):

1) From this folder:
   cd C:\Users\USER\Documents\Unimap\unimap-react

2) Install dependencies:
   npm install

3) Start the dev server:
   npm run dev

4) Open the printed localhost URL (usually http://localhost:5173)

Notes and next steps:
- This is intentionally minimal. It uses react-leaflet for safer React/Leaflet integration.
- To migrate, port pieces of your existing Unimap code into these components incrementally:
  - Map interactions and event wiring -> MapShell
  - Directions UI -> DirectionsPanel
  - Geofence logic -> move into a hook (e.g. src/hooks/useGeofence.js)
- If you prefer to keep plain Leaflet (no react-leaflet), mount it from MapShell via useEffect instead.

If you want, I can now:
- Produce the useGeofence.js hook and a sample unit-testable implementation.
- Port the existing directions scroll fix into the React panel (already applied via CSS here).
- Migrate a specific feature next (search, route builder, or geofence) — tell me which one.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>

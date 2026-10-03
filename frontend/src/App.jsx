import React, { useState, useCallback, useEffect, useMemo } from 'react';
import MapShell from './components/MapShell.jsx';
import SearchSheet from './components/SearchSheet.jsx';
import RoutePanel from './components/RoutePanel.jsx';
import TraceRecorder from './components/TraceRecorder.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import CorrectionForm from './components/CorrectionForm.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import { usePois } from './hooks/usePois.js';
import { useSearch } from './hooks/useSearch.js';
import { useGeolocation } from './hooks/useGeolocation.js';
import { useRouting } from './hooks/useRouting.js';
import { useArrival } from './hooks/useArrival.js';
import { useTheme } from './hooks/useTheme.js';
import { useGeofence } from './hooks/useGeofence.js';
import { useStoragePressure } from './hooks/useStoragePressure.js';
import { CAMPUS_CENTER, CAMPUS_NAME } from './lib/categories.js';

export default function App() {
  const { pois, status, error, fromCache, reload } = usePois();
  const search = useSearch(pois);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [showCorrection, setShowCorrection] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);

  const { theme, toggle } = useTheme();
  const geo = useGeolocation({ watch: true });
  const routing = useRouting();
  // Asks the browser not to evict our offline data.
  useStoragePressure();

  const arrival = useArrival({
    routeCoords: routing.result?.coords,
    destination: routing.result?.to,
    position: geo.position,
  });

  const geofence = useGeofence();
  const { checkPoint, canNavigate } = geofence;

  // Feed the campus gate from every GPS fix. Without this the geofence was
  // pure dead code: it decided "am I on campus" but nothing ever asked it.
  useEffect(() => {
    if (geo.position) checkPoint([geo.position.lat, geo.position.lng]);
  }, [geo.position, checkPoint]);

  /**
   * Whether directions are allowed right now.
   *
   * Off campus is refused, because the graph has nothing there and a
   * straight line 40 km away is not advice. But *before the first fix*
   * there is no position to judge, and refusing then left the "Directions"
   * button silently doing nothing -- so an unknown position is permitted and
   * the route simply starts from the campus centre.
   */
  const routingAllowed = !geo.position || canNavigate();

  /**
   * Ask for directions to a POI.
   */
  const goToPoi = useCallback(
    (poi) => {
      if (!poi) return;
      if (geo.position && !canNavigate()) return;
      const from = geo.position ?? { lat: CAMPUS_CENTER[0], lng: CAMPUS_CENTER[1] };
      routing.route(
        { lat: from.lat, lng: from.lng },
        { lat: poi.lat, lng: poi.lng },
      );
    },
    [canNavigate, geo.position, routing],
  );

  /** Tap the map: route from wherever you are to that point. */
  const handleMapClick = useCallback(
    (event) => {
      if (!routingAllowed) return;
      const from = geo.position ?? { lat: CAMPUS_CENTER[0], lng: CAMPUS_CENTER[1] };
      routing.route(
        { lat: from.lat, lng: from.lng },
        { lat: event.latlng.lat, lng: event.latlng.lng },
      );
    },
    [geo.position, routing, routingAllowed],
  );

  /**
   * How far the user currently is from any mapped path, as reported by the
   * last route request. Null until a route has been attempted.
   */
  const offNetworkMeters = useMemo(() => {
    const snapped = routing.result?.snappedOriginMeters;
    // Explicit null check: a user standing exactly on a path snaps at 0 m,
    // and `!0` would read that as "no measurement".
    return snapped == null ? null : snapped;
  }, [routing.result]);

  const handleMapReady = useCallback((instance) => {
    setMapReady(Boolean(instance));
  }, []);

  const handleSelect = useCallback(
    (poi) => {
      search.select(poi);
      setSheetOpen(false);
    },
    [search],
  );

  return (
    <div className="app" data-theme={theme}>
      <MapShell
        pois={pois}
        category={search.category}
        selectedId={search.selectedId}
        onSelect={handleSelect}
        userPosition={geo.position}
        accuracyMeters={geo.accuracyMeters}
        route={routing.result}
        onMapReady={handleMapReady}
        onMapClick={handleMapClick}
      />

      <div className="app__controls">
        <ThemeToggle theme={theme} onToggle={toggle} />
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => setSheetOpen(true)}
          aria-label="Search campus"
        >
          🔍
        </button>
      </div>

      {geo.status === 'denied' && (
        <p className="notice notice--warn" role="status">
          {geo.error}
          <button type="button" className="btn btn--link" onClick={geo.start}>Try again</button>
        </p>
      )}

      {geo.status === 'unavailable' && (
        <p className="notice" role="status">{geo.error}</p>
      )}

      {/* Directions are campus-only: the graph has nothing beyond the gate,
          so a route from there would be a straight line presented as advice. */}
      {geo.status === 'granted' && !canNavigate() && (
        <p className="notice notice--warn" role="status">
          You are off campus — directions are only available on {CAMPUS_NAME}.
        </p>
      )}

      {geo.status === 'idle' && status === 'ready' && (
        <button type="button" className="fab" onClick={geo.start}>
          Use my location
        </button>
      )}

      <RoutePanel
        result={routing.result}
        status={routing.status}
        error={routing.error}
        arrival={arrival}
        destinationName={routing.result?.to?.name}
        onDismiss={() => {
          routing.clear();
          arrival.reset();
        }}
        onReroute={() => {
          const selected = pois.find((p) => p.id === search.selectedId);
          if (selected) goToPoi(selected);
        }}
      />

      <InstallPrompt />

      {/* Offered only once the user is genuinely off the mapped network.
          Without a measured distance there is nothing to say, so it stays
          hidden rather than claiming "about 0 m from any mapped path". */}
      {showRecorder && geo.position && offNetworkMeters != null && (
        <TraceRecorder
          position={geo.position}
          offNetworkMeters={offNetworkMeters}
          onDismiss={() => setShowRecorder(false)}
        />
      )}

      {status === 'loading' && !mapReady && (
        <div className="skeleton" role="status" aria-live="polite">
          <div className="skeleton__spinner" />
          <p className="skeleton__text">Preparing campus map…</p>
        </div>
      )}

      {status === 'error' && (
        <div className="error-card" role="alert">
          <h2>Couldn’t load campus data</h2>
          <p>{error}</p>
          <button type="button" onClick={reload}>Try again</button>
        </div>
      )}

      {status === 'ready' && (
        <p className="poi-count" role="status">{pois.length} locations</p>
      )}

      {/* Say so when the map is running on saved data. Deliberately does not say
          "you are offline": the origin can be broken while the browser is
          perfectly online, and claiming otherwise would be its own lie. */}
      {fromCache && (
        <p className="notice notice--warn" role="status">
          Showing saved campus data — could not reach the server.
        </p>
      )}

      {/* A route attempt from far off the network is how a gap gets found.
          Offset above the POI actions so the buttons do not stack on top of
          each other. */}
      {routing.result?.mode === 'straight_line'
        && routing.result.reason === 'origin_off_network'
        && !showRecorder
        && geo.status === 'granted' && (
        <button
          type="button"
          className="fab fab--tertiary"
          onClick={() => setShowRecorder(true)}
        >
          Missing path here? Record it
        </button>
      )}

      {search.selectedId && (
        <>
          <button
            type="button"
            className="fab"
            onClick={() => goToPoi(pois.find((p) => p.id === search.selectedId))}
          >
            Directions here
          </button>
          <button
            type="button"
            className="fab fab--secondary"
            onClick={() => setShowCorrection(true)}
          >
            Report a problem
          </button>
        </>
      )}

      {showCorrection && (
        <CorrectionForm
          poi={pois.find((p) => p.id === search.selectedId)}
          onClose={() => setShowCorrection(false)}
        />
      )}

      <SearchSheet
        open={sheetOpen}
        onClose={() => setSheetOpen((o) => !o)}
        query={search.query}
        onQueryChange={search.setQuery}
        categories={search.categories}
        category={search.category}
        onToggleCategory={search.toggleCategory}
        results={search.results}
        popular={search.popular}
        selectedId={search.selectedId}
        onSelect={handleSelect}
        onRoute={goToPoi}
      />
    </div>
  );
}
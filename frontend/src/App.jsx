import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
  const mapRef = useRef(null);

  const { theme, toggle } = useTheme();
  const geo = useGeolocation({ watch: true });
  const routing = useRouting();
  // Asks the browser not to evict our offline data, and reports pressure.
  useStoragePressure();

  const arrival = useArrival({
    routeCoords: routing.result?.coords,
    destination: routing.result?.to,
    position: geo.position,
  });

  // Whether the POI list came from the cache rather than the network.
  const geofence = useGeofence();

  // Feed the campus gate from every GPS fix. Without this the geofence was
  // pure dead code: it decided "am I on campus" but nothing ever asked it.
  const { checkPoint, isOnCampus, canNavigate } = geofence;

  useEffect(() => {
    if (geo.position) checkPoint([geo.position.lat, geo.position.lng]);
  }, [geo.position, checkPoint]);

  /**
   * Ask for directions, but only from on campus.
   *
   * Guidance is useless 40 km away — the graph has nothing there and the
   * straight-line fallback would be actively misleading.
   */
  const goToPoi = useCallback(
    (poi) => {
      if (!poi) return;
      if (!canNavigate()) return;
      const from = geo.position ?? { lat: CAMPUS_CENTER[0], lng: CAMPUS_CENTER[1] };
      routing.route(
        { lat: from.lat, lng: from.lng },
        { lat: poi.lat, lng: poi.lng },
      );
    },
    [canNavigate, geo.position, routing],
  );

  /** Tap the map with nothing selected: route from the user to that point. */
  const handleMapClick = useCallback(
    (event) => {
      const poi = search.selectedId
        ? pois.find((p) => p.id === search.selectedId)
        : null;
      if (poi) goToPoi(poi);
      else if (geo.position && canNavigate()) {
        routing.route(
          { lat: geo.position.lat, lng: geo.position.lng },
          { lat: event.latlng.lat, lng: event.latlng.lng },
        );
      }
    },
    [canNavigate, geo.position, goToPoi, pois, routing, search.selectedId],
  );

  /**
   * How far the user currently is from any mapped path.
   *
   * Drives both the "re-route" nag and the trace recorder. 120 m is the
   * threshold: inside that the graph is still a usable description of where
   * you are, beyond it the app is quietly guessing.
   */
  const offNetworkMeters = useMemo(() => {
    if (!geo.position || !routing.result?.snappedOriginMeters) return null;
    return routing.result.snappedOriginMeters;
  }, [geo.position, routing.result]);

  // Leaflet instance handed up by MapEvents once the map exists.
  const handleMapReady = useCallback((instance) => {
    mapRef.current = instance;
    setMapReady(true);
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

      {/* Offered only once the user is genuinely off the mapped network. */}
      {showRecorder && geo.position && (
        <TraceRecorder
          position={geo.position}
          offNetworkMeters={offNetworkMeters ?? 0}
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

      {/* Say so when the map is running on saved data, rather than letting the
          user assume they are seeing live campus information. */}
      {fromCache && (
        <p className="notice notice--warn" role="status">
          Showing saved campus data — you are offline.
        </p>
      )}

      {/* A route attempt from far off the network is how a gap gets found. */}
      {routing.result?.mode === 'straight_line'
        && routing.result.reason === 'origin_off_network'
        && !showRecorder
        && geo.status === 'granted' && (
        <button type="button" className="fab" onClick={() => setShowRecorder(true)}>
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
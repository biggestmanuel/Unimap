import React, { useState, useCallback } from 'react';
import MapShell from './components/MapShell.jsx';
import SearchSheet from './components/SearchSheet.jsx';
import { usePois } from './hooks/usePois.js';
import { useSearch } from './hooks/useSearch.js';
import { useGeofence } from './hooks/useGeofence.js';

export default function App() {
  const { pois, status, error, reload } = usePois();
  const search = useSearch(pois);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  // Wired ahead of Phase 2: the boundary decision is pure and tested now,
  // the GPS loop that feeds it arrives with navigation.
  useGeofence();

  const handleSelect = useCallback(
    (poi) => {
      search.select(poi);
      setSheetOpen(false);
    },
    [search],
  );

  return (
    <div className="app">
      <MapShell
        pois={pois}
        category={search.category}
        selectedId={search.selectedId}
        onSelect={handleSelect}
        onMapReady={() => setMapReady(true)}
      />

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
          <button type="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && (
        <p className="poi-count" role="status">
          {pois.length} locations
        </p>
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
      />
    </div>
  );
}
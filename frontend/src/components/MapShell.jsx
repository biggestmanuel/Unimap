import React, { useCallback, useEffect, useState } from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import PoiMarkerLayer from './PoiMarkerLayer.jsx';
import UserMarkerLayer from './UserMarkerLayer.jsx';
import RouteLine from './RouteLine.jsx';
import MapEvents from './MapEvents.jsx';
import TileWatcher from './TileWatcher.jsx';
import { tileHost } from '../lib/tileStatus.js';
import { CAMPUS_CENTER, CAMPUS_ZOOM } from '../lib/categories.js';

/**
 * Tile URL.
 *
 * Defaults to the public OSM servers, which is fine for development and
 * light use but is rate-limited and not guaranteed offline. Set
 * `VITE_TILE_URL` to a self-hosted TileServer before real campus traffic --
 * see docs/TILES.md. Keeping it in one place means switching providers is a
 * config change, not a code change.
 */
const TILE_URL =
  import.meta.env.VITE_TILE_URL
  ?? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

const TILE_ATTRIBUTION =
  import.meta.env.VITE_TILE_ATTRIBUTION
  ?? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const MAX_ZOOM = Number(import.meta.env.VITE_TILE_MAX_ZOOM ?? 19);

/**
 * Map host. Deliberately thin: it owns the Leaflet instance and the
 * tile layer, and hands the map object down via react-leaflet context.
 * All POI behaviour lives in PoiMarkerLayer.
 */
export default function MapShell({
  pois,
  category,
  selectedId,
  onSelect,
  userPosition,
  accuracyMeters,
  route,
  onMapReady,
  onMapClick,
  children,
}) {
  const [tileProblem, setTileProblem] = useState(null);
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Stable identity, so `TileWatcher` does not re-subscribe on every render.
  const onTileStatus = useCallback((status) => setTileProblem(status), []);

  return (
    <div className="map-shell">
      <MapContainer
        center={CAMPUS_CENTER}
        zoom={CAMPUS_ZOOM}
        zoomControl={false}
        attributionControl
        // Campus sits well south of the equator: OSM is north-up, no flip.
        preferCanvas
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          url={TILE_URL}
          attribution={TILE_ATTRIBUTION}
          maxZoom={MAX_ZOOM}
        />
        <MapEvents onClick={onMapClick} onReady={onMapReady} />
        <TileWatcher onStatus={onTileStatus} isOnline={isOnline} />
        <PoiMarkerLayer
          pois={pois}
          category={category}
          selectedId={selectedId}
          onSelect={onSelect}
        />
        <UserMarkerLayer position={userPosition} accuracyMeters={accuracyMeters} />
        {route && <RouteLine coords={route.coords} mode={route.mode} />}
        {children}
      </MapContainer>

      {/*
        The basemap refusing to load and the device being offline look
        identical from here: a grey grid. This says which one it is, because
        the offline case is expected and the refused case means the shared
        public tile server has throttled the campus -- see docs/TILES.md.
      */}
      {tileProblem && (
        <p
          className={`map-tile-notice map-tile-notice--${tileProblem.kind}`}
          role="status"
        >
          {tileProblem.message}
          {tileProblem.kind === 'blocked' && tileHost(TILE_URL) && (
            <> Source: {tileHost(TILE_URL)}.</>
          )}
        </p>
      )}
    </div>
  );
}
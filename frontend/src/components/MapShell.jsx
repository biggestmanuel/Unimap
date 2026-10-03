import React from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import PoiMarkerLayer from './PoiMarkerLayer.jsx';
import UserMarkerLayer from './UserMarkerLayer.jsx';
import RouteLine from './RouteLine.jsx';
import MapEvents from './MapEvents.jsx';
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
    </div>
  );
}
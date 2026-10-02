import React from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import PoiMarkerLayer from './PoiMarkerLayer.jsx';
import { CAMPUS_CENTER, CAMPUS_ZOOM } from '../lib/categories.js';

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
  onMapReady,
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
        whenCreated={(instance) => onMapReady?.(instance)}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        <PoiMarkerLayer
          pois={pois}
          category={category}
          selectedId={selectedId}
          onSelect={onSelect}
          userPosition={userPosition}
        />
        {children}
      </MapContainer>
    </div>
  );
}
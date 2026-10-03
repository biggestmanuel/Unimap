import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { createPoiIcon } from './markers.js';
import { formatDistance } from '../lib/geo.js';

/**
 * Imperative marker layer.
 *
 * Markers are Leaflet objects held in a ref, NOT React state. React
 * re-renders this component only when the POI set or the active
 * category changes; showing/hiding a marker is a direct DOM-layer
 * mutation. That is the difference between a filter toggle costing one
 * diff and costing 79 marker rebuilds.
 *
 * Tracking (Phase 2) extends the same rule: the user marker moves via
 * setLatLng inside a watchPosition loop and never through setState.
 */
// The user marker is NOT drawn here. UserMarkerLayer owns it, and keeping a
// second copy in this layer put two identical markers on the map.
export default function PoiMarkerLayer({ pois, category, selectedId, onSelect }) {
  const map = useMap();
  const layerRef = useRef(null);
  const markersRef = useRef(new Map());
  const poisRef = useRef(pois);
  poisRef.current = pois;

  // Build the layer group once and keep it for the life of the map.
  useEffect(() => {
    const layer = L.layerGroup().addTo(map);
    layerRef.current = layer;
    return () => {
      map.removeLayer(layer);
      layerRef.current = null;
      markersRef.current.clear();
    };
  }, [map]);

  // Reconcile markers against the POI set.
  useEffect(() => {
    const layer = layerRef.current;
    const markers = markersRef.current;
    if (!layer) return;

    const seen = new Set();

    pois.forEach((poi) => {
      seen.add(poi.id);
      let marker = markers.get(poi.id);

      if (!marker) {
        marker = L.marker(poi.position, {
          icon: createPoiIcon(poi.category),
          keyboard: true,
          alt: poi.name,
          riseOnHover: true,
        });
        marker.bindPopup(
          `<div class="poi-popup">
             <p class="poi-popup__name"></p>
             <p class="poi-popup__category"></p>
             <div class="poi-popup__meta"></div>
           </div>`,
          { maxWidth: 260, className: 'poi-popup-shell' },
        );
        marker.on('click', () => onSelect?.(poi));
        marker.addTo(layer);
        markers.set(poi.id, marker);
      }

      // Popup content is written via DOM text nodes, never innerHTML with
      // POI data: student-submitted corrections will eventually flow here.
      const el = marker.getPopup()?.getElement();
      if (el) {
        el.querySelector('.poi-popup__name').textContent = poi.name;
        el.querySelector('.poi-popup__category').textContent = poi.categoryLabel;
        const meta = el.querySelector('.poi-popup__meta');
        meta.textContent = '';
        if (poi.description) {
          const d = document.createElement('p');
          d.className = 'poi-popup__desc';
          d.textContent = poi.description;
          meta.appendChild(d);
        }
      }
    });

    // Drop markers for POIs that no longer exist.
    for (const [id, marker] of markers) {
      if (!seen.has(id)) {
        layer.removeLayer(marker);
        markers.delete(id);
      }
    }
  }, [pois, onSelect]);

  // Category filter: mutate opacity, never rebuild.
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const poi = poisRef.current.find((p) => p.id === id);
      const visible = !category || poi?.category === category;
      const el = marker.getElement();
      if (!el) continue;
      el.style.opacity = visible ? '1' : '0.15';
      el.style.pointerEvents = visible ? 'auto' : 'none';
    }
  }, [category]);

  // Selection: highlight and frame it.
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const el = marker.getElement();
      if (el) el.classList.toggle('is-selected', id === selectedId);
    }
    if (!selectedId) return;
    const marker = markersRef.current.get(selectedId);
    const poi = poisRef.current.find((p) => p.id === selectedId);
    if (marker && poi) {
      map.flyTo(poi.position, Math.max(map.getZoom(), 17), { duration: 0.6 });
    }
  }, [selectedId, map]);

  return null;
}
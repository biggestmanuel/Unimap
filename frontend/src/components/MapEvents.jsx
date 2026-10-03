import React, { useEffect } from 'react';
import { useMapEvents } from 'react-leaflet';

/**
 * Bridges Leaflet's map events into React callbacks.
 *
 * react-leaflet has no `onClick` prop on `MapContainer`, so this is the
 * supported way to get one. It renders nothing — the handler is the point.
 *
 * Isolated here so `MapShell` stays a thin host and the event wiring is the
 * only thing that has to know how react-leaflet wants to be talked to.
 */
export default function MapEvents({ onClick, onReady }) {
  const map = useMapEvents({
    click: (event) => onClick?.(event),
  });

  useEffect(() => {
    onReady?.(map);
  }, [map, onReady]);

  return null;
}
import React, { useEffect, useMemo } from 'react';
import { Polyline } from 'react-leaflet';

/**
 * The route polyline.
 *
 * The stroke is deliberately heavy and high-contrast: this is read on a phone,
 * outdoors, in daylight, often one-handed. Casing underneath the line keeps it
 * legible over both dark asphalt and pale paths.
 */
export default function RouteLine({ coords, mode = 'graph', onReady }) {
  // Leaflet wants [lat, lng]; the API speaks {lat, lng}.
  const positions = useMemo(
    () => (Array.isArray(coords) ? coords.map((p) => [p.lat, p.lng]) : []),
    [coords],
  );

  useEffect(() => {
    if (positions.length >= 2) onReady?.(positions);
  }, [positions, onReady]);

  if (positions.length < 2) return null;

  // A straight-line fallback is dashed, so it never reads as a real path.
  const dashed = mode === 'straight_line';

  return (
    <>
      <Polyline
        positions={positions}
        pathOptions={{
          color: '#0f172a',
          weight: 9,
          opacity: 0.25,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
      <Polyline
        positions={positions}
        pathOptions={{
          color: dashed ? '#f59e0b' : '#2563eb',
          weight: 5,
          opacity: 0.95,
          dashArray: dashed ? '2 9' : undefined,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
    </>
  );
}
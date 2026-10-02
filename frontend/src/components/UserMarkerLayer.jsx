import React, { useEffect, useRef } from 'react';
import { Marker, Circle } from 'react-leaflet';
import L from 'leaflet';

/**
 * The user's position.
 *
 * The marker is updated imperatively through its Leaflet instance rather than
 * by re-rendering: `watchPosition` fires about once a second, and going
 * through React state for every fix would re-render the POI layer with it.
 *
 * The accuracy circle is what makes the marker trustworthy -- a 60 m blob
 * explains why the route starts from the kerb rather than your feet.
 */
export default function UserMarkerLayer({ position, accuracyMeters, showHeading = true }) {
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const first = useRef(true);

  useEffect(() => {
    if (!position) return;
    const here = L.latLng(position.lat, position.lng);

    if (markerRef.current) {
      markerRef.current.setLatLng(here);
      if (first.current) {
        markerRef.current.setZIndexOffset(1000);
        first.current = false;
      }
    }
    if (circleRef.current) {
      circleRef.current.setLatLng(here);
      if (accuracyMeters != null) circleRef.current.setRadius(accuracyMeters);
    }
  }, [position, accuracyMeters]);

  if (!position) return null;

  // A plain divIcon rather than an image: no asset to ship, and it inherits
  // the theme colours.
  const icon = L.divIcon({
    className: 'user-marker',
    html: '<span class="user-marker__dot" />',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  return (
    <>
      {accuracyMeters != null && (
        <Circle
          ref={circleRef}
          center={[position.lat, position.lng]}
          radius={accuracyMeters}
          pathOptions={{ color: '#2563eb', weight: 1, opacity: 0.4, fillOpacity: 0.08 }}
        />
      )}
      <Marker
        ref={markerRef}
        position={[position.lat, position.lng]}
        icon={icon}
        // The user does not need a popup telling them where they are.
        interactive={false}
        keyboard={false}
        alt="Your position"
        title={showHeading ? 'You are here' : undefined}
      />
    </>
  );
}
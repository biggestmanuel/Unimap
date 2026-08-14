import React, { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

// Basic MapShell using react-leaflet. Keeps map mounting in React and
// exposes a small onRouteFound callback for route instructions.
export default function MapShell({ onRouteFound }) {
  const mapRef = useRef(null)

  // Example: set initial view to a reasonable default (adjust as needed)
  const center = [9.0820, 8.6753] // Nigeria approx center — replace with your region

  useEffect(() => {
    if (!mapRef.current) return
    const map = mapRef.current
    // any imperative Leaflet code that needs direct access can go here
  }, [])

  return (
    <div className="map-shell">
      <MapContainer
        center={center}
        zoom={13}
        style={{ height: '100vh', width: '100%' }}
        whenCreated={(mapInstance) => { mapRef.current = mapInstance }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Example marker — replace with dynamic content or user location */}
        <Marker position={center}>
          <Popup>UniMap start</Popup>
        </Marker>
      </MapContainer>

      {/* Small example control: simulate route found to populate directions panel */}
      <div className="map-controls">
        <button
          className="unimap-ctrl"
          onClick={() => {
            // Simulate route instructions — in a real app, compute or fetch route
            const instructions = [
              'Head north for 200m',
              'Turn right onto Example St',
              'Continue 1.2km to destination',
            ]
            onRouteFound(instructions)
          }}
        >
          Show example route
        </button>
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import MapShell from './components/MapShell'
import DirectionsPanel from './components/DirectionsPanel'

export default function App() {
  const [routeInstructions, setRouteInstructions] = useState([])
  const [sidebarOpen, setSidebarOpen] = useState(true)

  function handleRouteFound(instructions) {
    setRouteInstructions(instructions)
    setSidebarOpen(true)
  }

  return (
    <div className="unimap-root">
      <MapShell onRouteFound={handleRouteFound} />
      <DirectionsPanel
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        instructions={routeInstructions}
      />
    </div>
  )
}

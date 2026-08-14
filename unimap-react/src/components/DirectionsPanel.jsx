import React from 'react'

export default function DirectionsPanel({ open = true, onClose = () => {}, instructions = [] }) {
  return (
    <aside className={`directions-panel ${open ? 'open' : 'closed'}`} aria-hidden={!open}>
      <div className="directions-header">
        <h2>Directions</h2>
        <button onClick={onClose} aria-label="Close directions">✕</button>
      </div>

      <div className="directions-body" role="region" aria-label="Route instructions">
        {instructions.length === 0 ? (
          <p className="empty">No route selected. Click "Show example route" on the map to demo.</p>
        ) : (
          <ol>
            {instructions.map((ins, i) => (
              <li key={i}>{ins}</li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}

import React from 'react';
import { formatDistance, formatDuration } from '../hooks/useRouting.js';

/**
 * Fetch and HTTP errors reach this component as raw text ("Failed to fetch",
 * "HTTP 503"). A student cannot act on that. Map the network-shaped failures
 * to a message that says what to do, and leave everything else generic.
 */
function friendlyRouteError(error) {
  const text = String(error ?? '').toLowerCase();
  if (/fetch|network|timeout|\b5\d\d\b/.test(text)) {
    return 'Could not reach the campus routing service. Check your connection and try again.';
  }
  return 'Could not work out a route. Please try again.';
}

/**
 * Turn-by-turn route summary.
 *
 * Shown as a bottom sheet so it never covers the map the user is following.
 * The fallback state is worded carefully: a dashed line is a guess, and
 * presenting it as a real route would be worse than admitting it.
 */
export default function RoutePanel({
  result,
  status,
  error,
  arrival,
  destinationName,
  onDismiss,
  onReroute,
  originApproximate = false,
}) {
  if (status === 'idle' && !result) return null;

  if (status === 'loading' && !result) {
    return (
      <section className="route-panel route-panel--loading" aria-live="polite">
        <p className="route-panel__status">Finding a path…</p>
      </section>
    );
  }

  if (status === 'error' && !result) {
    return (
      <section className="route-panel route-panel--error" role="alert">
        <p className="route-panel__status">{friendlyRouteError(error)}</p>
        <div className="route-panel__actions">
          {onReroute && (
            <button type="button" className="btn btn--primary" onClick={onReroute}>
              Try again
            </button>
          )}
          {onDismiss && (
            <button type="button" className="btn btn--ghost" onClick={onDismiss}>Close</button>
          )}
        </div>
      </section>
    );
  }

  if (!result) return null;

  const fallback = result.mode === 'straight_line';

  return (
    <section className="route-panel" aria-live="polite">
      <header className="route-panel__header">
        <div>
          <p className="route-panel__eyebrow">
            {destinationName ? `To ${destinationName}` : 'Directions'}
          </p>
          <p className="route-panel__summary">
            <strong>{formatDistance(result.distanceMeters)}</strong>
            <span aria-hidden="true"> · </span>
            <span>{formatDuration(result.durationSeconds)}</span>
          </p>
        </div>
        {onDismiss && (
          <button type="button" className="btn btn--ghost" onClick={onDismiss} aria-label="Close directions">
            ✕
          </button>
        )}
      </header>

      {/* With no GPS fix the request starts at the campus centre. Hiding that
          makes the route look like it begins at the student's feet. */}
      {originApproximate && (
        <p className="route-panel__notice route-panel__notice--info" role="status">
          Starting from the campus centre. Use my location for directions from here.
        </p>
      )}

      {fallback && (
        <p className="route-panel__notice route-panel__notice--warn">
          {result.reason === 'network_disconnected'
            ? 'No connected path between these two points — showing a straight line.'
            : 'One end is off the mapped paths — showing a straight line.'}
        </p>
      )}

      {arrival?.arrived && (
        <p className="route-panel__notice route-panel__notice--good">
          You have arrived.
          {onDismiss && (
            <button type="button" className="btn btn--link" onClick={onDismiss}>Done</button>
          )}
        </p>
      )}

      {!arrival?.arrived && arrival?.offRoute && (
        <p className="route-panel__notice route-panel__notice--warn" role="status">
          You have left the path.
          {onReroute && (
            <button type="button" className="btn btn--link" onClick={onReroute}>
              Re-route
            </button>
          )}
        </p>
      )}

      {arrival?.remainingMeters != null && !arrival.arrived && (
        <p className="route-panel__remaining">
          {formatDistance(arrival.remainingMeters)} to go
        </p>
      )}

      {Array.isArray(result.legs) && result.legs.length > 0 && (
        <ol className="route-panel__legs">
          {result.legs.map((leg, i) => (
            <li key={`${i}-${leg.name ?? 'leg'}`} className="route-leg">
              <span
                className={`route-leg__badge route-leg__badge--${leg.edgeClass}`}
                aria-hidden="true"
              />
              <span className="route-leg__name">{leg.name ?? 'Unnamed path'}</span>
              <span className="route-leg__dist">{formatDistance(leg.lengthMeters)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
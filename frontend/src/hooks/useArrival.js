import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Great-circle distance in metres between two {lat,lng}. */
export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Remaining distance to the end of the route polyline, in metres.
 *
 * Anchored to the nearest *vertex*, then counts forward from there. Walking
 * forward from the start instead would report 0 m the moment the user stands
 * on the first vertex, and would let GPS jitter over a vertex make the
 * remaining distance jump back up.
 */
export function remainingMeters(routeCoords, here) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2 || !here) return Infinity;

  let nearestIndex = 0;
  let nearest = Infinity;
  for (let i = 0; i < routeCoords.length; i += 1) {
    const d = distanceMeters(routeCoords[i], here);
    if (d < nearest) {
      nearest = d;
      nearestIndex = i;
    }
  }

  let total = 0;
  for (let i = nearestIndex + 1; i < routeCoords.length; i += 1) {
    total += distanceMeters(routeCoords[i - 1], routeCoords[i]);
  }
  return total;
}

/**
 * Arrival detection and off-route detection.
 *
 * `ARRIVAL_METERS` is generous on purpose. Campus GPS without a beacon is
 * routinely 15–30 m out, and a tight threshold means the app congratulates
 * you on arriving while you are still crossing the car park.
 */
const ARRIVAL_METERS = 35;

/** Consecutive fixes off the route before we suggest re-routing. */
const OFF_ROUTE_FIXES = 3;

/**
 * Watches progress along a route.
 *
 * Returns whether the user has arrived, how far they have left to walk, and
 * whether they have wandered far enough off the route to be worth
 * interrupting them about.
 */
export function useArrival({ routeCoords, destination, position, toleranceMeters = ARRIVAL_METERS }) {
  const [arrived, setArrived] = useState(false);
  const [offRoute, setOffRoute] = useState(false);
  const [remaining, setRemaining] = useState(null);

  const offRouteCount = useRef(0);
  const announceTimer = useRef(null);

  // Reset whenever the destination changes, so arriving at the library does
  // not leave the flag set when you then walk to the canteen.
  useEffect(() => {
    setArrived(false);
    offRouteCount.current = 0;
    setOffRoute(false);
    setRemaining(null);
  }, [destination?.lat, destination?.lng]);

  useEffect(() => {
    if (!position || !destination) return;

    const toGo = distanceMeters(position, destination);
    setRemaining(Number.isFinite(toGo) ? toGo : null);

    if (toGo <= toleranceMeters) {
      setArrived(true);
      return;
    }

    if (Array.isArray(routeCoords) && routeCoords.length >= 2) {
      // Distance from the live position to the nearest point on the route.
      let nearest = Infinity;
      for (let i = 1; i < routeCoords.length; i += 1) {
        const d = distanceMeters(position, routeCoords[i]);
        if (d < nearest) nearest = d;
        const other = distanceMeters(position, routeCoords[i - 1]);
        if (other < nearest) nearest = other;
      }

      if (nearest > 120) {
        offRouteCount.current += 1;
        // Require consecutive fixes so a single bad reading does not nag.
        if (offRouteCount.current >= OFF_ROUTE_FIXES) setOffRoute(true);
      } else {
        offRouteCount.current = 0;
        setOffRoute(false);
      }
    }
  }, [position, destination, routeCoords, toleranceMeters]);

  // Clear the off-route flag when a new route is supplied.
  useEffect(() => {
    if (routeCoords?.length) {
      offRouteCount.current = 0;
      setOffRoute(false);
    }
  }, [routeCoords]);

  useEffect(() => () => clearTimeout(announceTimer.current), []);

  const reset = useCallback(() => {
    setArrived(false);
    setOffRoute(false);
    offRouteCount.current = 0;
  }, []);

  return useMemo(
    () => ({ arrived, offRoute, remainingMeters: remaining, reset }),
    [arrived, offRoute, remaining, reset],
  );
}
import { useCallback, useState } from 'react';
import { isPointInPolygon } from '../lib/geo.js';
import { RSU_CAMPUS_POLYGON, GEOFENCE_BUFFER_METERS } from '../lib/categories.js';

/**
 * `?dev=1` disables the campus gate so the app can be exercised from
 * home. Deliberately query-string only — never enable it in a build
 * that ships, since it removes the out-of-campus guard.
 */
export function isDevBypass(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return new URLSearchParams(search).get('dev') === '1';
  } catch {
    return false;
  }
}

/**
 * Campus boundary check.
 *
 * Scope note: this is the pure decision only — point in, point out,
 * should navigation be allowed. The GPS watchPosition loop that feeds
 * it points in is Phase 2. Keeping the decision separate is what makes
 * it testable without device hardware.
 */
export function useGeofence({ bypass = isDevBypass() } = {}) {
  const [isOnCampus, setIsOnCampus] = useState(false);

  /** @param {[number, number]} position [lat, lng] */
  const checkPoint = useCallback(
    (position) => {
      if (bypass) return true;
      if (!Array.isArray(position)) return false;
      const inside = isPointInPolygon(position, RSU_CAMPUS_POLYGON, GEOFENCE_BUFFER_METERS);
      setIsOnCampus(inside);
      return inside;
    },
    [bypass],
  );

  /** Navigation is campus-only: guidance is useless 40 km off-site. */
  const canNavigate = useCallback(() => (bypass ? true : isOnCampus), [bypass, isOnCampus]);

  return { isOnCampus, canNavigate, checkPoint, bypass };
}
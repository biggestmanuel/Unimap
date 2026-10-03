import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Live position via `watchPosition`.
 *
 * Two deliberate choices:
 *
 * - `enableHighAccuracy` is on. GPS error indoors is the difference between a
 *   route that starts where you are and one that starts 80 m away.
 * - Positions are written to a ref as well as state. The map marker moves
 *   imperatively off the ref so a 1 Hz update does not re-render the whole
 *   POI layer sixty times a minute.
 *
 * `status` distinguishes "asked but refused" from "never asked", because the
 * first needs a button and the second needs an explanation.
 */
export function useGeolocation({
  watch = true,
  maxAgeMs = 5000,
  timeoutMs = 20000,
} = {}) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | locating | granted | denied | unavailable
  const [accuracyMeters, setAccuracyMeters] = useState(null);

  const latest = useRef(null);
  const watchId = useRef(null);
  // Tracked separately from `watchId` because the "already watching" guard
  // has to hold even if a platform hands back a falsy id.
  const watching = useRef(false);

  const clear = useCallback(() => {
    if (watchId.current != null && typeof navigator !== 'undefined') {
      navigator.geolocation?.clearWatch(watchId.current);
    }
    watchId.current = null;
    watching.current = false;
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unavailable');
      setError('This browser cannot report your location.');
      return;
    }

    // Starting twice would leave the first watch running: `clear` only knows
    // about the most recent id, so the orphan keeps firing forever.
    if (watching.current) return;

    setStatus('locating');
    setError(null);

    const onSuccess = (pos) => {
      const next = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy,
        heading: pos.coords.heading,
        timestamp: pos.timestamp,
      };
      latest.current = next;
      setPosition(next);
      setAccuracyMeters(pos.coords.accuracy);
      setStatus('granted');
      setError(null);
    };

    const onError = (err) => {
      // PERMISSION_DENIED is the interesting one; the rest are usually
      // transient and will clear on the next fix.
      if (err.code === 1) {
        setStatus('denied');
        setError('Location permission was declined. Turn it on to get directions.');
        clear();
        return;
      }

      // Anything else is transient, but the watch keeps retrying and may yet
      // succeed. Drop back to 'idle' if no fix ever arrived, so the "Use my
      // location" button comes back -- otherwise a single timeout left the
      // user stuck on a spinner with no way to retry.
      if (err.code === 3) {
        setError('Taking too long to find you. Try near a window.');
      } else {
        setError('Could not get a position fix.');
      }
      setStatus((s) => (s === 'locating' ? 'idle' : s));
    };

    if (watch) {
      watchId.current = navigator.geolocation.watchPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: maxAgeMs,
        timeout: timeoutMs,
      });
      watching.current = true;
    } else {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: maxAgeMs,
        timeout: timeoutMs,
      });
    }
  }, [watch, maxAgeMs, timeoutMs, clear]);

  const stop = useCallback(() => {
    clear();
    setStatus((s) => (s === 'granted' ? 'idle' : s));
  }, [clear]);

  useEffect(() => clear, [clear]);

  return {
    position,
    latest,
    error,
    status,
    accuracyMeters,
    start,
    stop,
    /** True when a fix is good enough to trust for routing. */
    isAccurate: accuracyMeters != null && accuracyMeters <= 50,
  };
}
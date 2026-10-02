import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/** Format metres for a walking distance readout. */
export function formatDistance(meters) {
  if (meters == null || !Number.isFinite(meters)) return '–';
  if (meters < 1000) return `${Math.round(meters / 5) * 5} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Format a duration in seconds as a short walking time. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '–';
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Ask the API for a walking route.
 *
 * Kept deliberately dumb: it owns request bookkeeping and nothing else, so
 * the abort behaviour and the stale-response guard are testable without a
 * map. `result` is null until a route succeeds or falls back.
 */
export function useRouting() {
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState(null);

  const controller = useRef(null);
  // Guards against an earlier, slower request overwriting a later one.
  const requestId = useRef(0);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    requestId.current += 1;
    setStatus((s) => (s === 'loading' ? 'idle' : s));
  }, []);

  const route = useCallback(async (from, to, options = {}) => {
    if (!from || !to) {
      setError('Need a start and a destination.');
      setStatus('error');
      return null;
    }

    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    const id = requestId.current + 1;
    requestId.current = id;

    setStatus('loading');
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, ...options }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `Routing failed (${res.status})`);
      }

      const data = await res.json();
      if (requestId.current !== id) return null; // superseded

      setResult(data);
      setStatus('ready');
      return data;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      if (requestId.current !== id) return null;
      setError(err.message);
      setStatus('error');
      return null;
    } finally {
      if (controller.current === ac) controller.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResult(null);
    setError(null);
    setStatus('idle');
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { result, status, error, route, clear, cancel };
}
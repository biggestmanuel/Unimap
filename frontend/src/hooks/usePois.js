import { useEffect, useState, useCallback, useRef } from 'react';
import { normalizeCollection } from '../lib/pois.js';
import { cachePois, getCachedPois, flushQueue } from '../lib/offlineCache.js';

export const PAI_URL = `${import.meta.env.BASE_URL}data/unimap.geojson`;
export const GRAPH_URL = `${import.meta.env.BASE_URL}data/walk-graph.json`;

const RETRY = { maxAttempts: 3, initialDelayMs: 600, backoff: 2, timeoutMs: 8000 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch() with a timeout. Aborts the underlying request on expiry. */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff, 3 attempts. Throws the last error if all fail. */
export async function fetchWithRetry(url, config = RETRY) {
  let delay = config.initialDelayMs;
  let lastError;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fetchWithTimeout(url, config.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === config.maxAttempts) break;
      await sleep(delay);
      delay *= config.backoff;
    }
  }

  throw lastError;
}

/**
 * Loads the campus POI directory once on mount.
 *
 * Network first, cache as the fallback rather than the other way round: a
 * stale directory is worse than a slightly slower fresh one. On success the
 * response is written to IndexedDB so the *next* cold start works with no
 * signal at all.
 *
 * The offline queue is drained here too, because this is the one place that
 * already runs on every cold start.
 */
export function usePois() {
  const [pois, setPois] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);
  // True when the directory on screen came out of IndexedDB rather than the
  // network. Distinct from `offline`: the browser can be online while the
  // origin is broken, and the user still needs to know this is saved data.
  const [fromCache, setFromCache] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const geojson = await fetchWithRetry(PAI_URL);
      if (!mounted.current) return;
      setPois(normalizeCollection(geojson));
      setStatus('ready');
      setOffline(false);
      setFromCache(false);
      // Fire-and-forget: a cache failure must not affect this render.
      cachePois(geojson).catch(() => {});
      flushQueue().catch(() => {});
    } catch (err) {
      // Offline or the origin is failing: fall back to whatever was cached.
      const cached = await getCachedPois();
      if (cached?.geojson && mounted.current) {
        setPois(normalizeCollection(cached.geojson));
        setStatus('ready');
        setOffline(true);
        setFromCache(true);
        return;
      }
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load campus data');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // Flag a mid-session drop so the UI can say so, rather than the user
  // wondering why the map has stopped updating.
  useEffect(() => {
    const onOffline = () => setOffline(true);
    const onOnline = () => setOffline(false);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return { pois, status, error, offline, fromCache, reload };
}
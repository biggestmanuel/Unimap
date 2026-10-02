import { useEffect, useState, useCallback, useRef } from 'react';
import { normalizeCollection } from '../lib/pois.js';

export const PAI_URL = `${import.meta.env.BASE_URL}data/unimap.geojson`;

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
 * Phase 1 deliberately keeps this simple; the IndexedDB cache layer
 * lands in the offline phase.
 */
export function usePois() {
  const [pois, setPois] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const geojson = await fetchWithRetry(PAI_URL);
      if (!mounted.current) return;
      setPois(normalizeCollection(geojson));
      setStatus('ready');
    } catch (err) {
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

  return { pois, status, error, reload };
}
import { useCallback, useEffect, useState } from 'react';
import { estimateUsage, requestPersistence, cachePois } from '../lib/offlineCache.js';
import { PAI_URL } from './usePois.js';

/**
 * Storage pressure and eviction.
 *
 * iOS evicts IndexedDB for sites a user has not visited in about seven days,
 * and it does so silently — the next launch simply finds an empty database
 * with no error. The only defence is to ask for persistent storage, and to
 * notice when the cache has been emptied underneath us so the user can be
 * told rather than quietly losing their offline map.
 *
 * `navigator.storage.persist()` only exists in Chromium. On Safari the request
 * is a no-op, so this is an optimisation, never a dependency.
 */
export function useStoragePressure() {
  const [usage, setUsage] = useState(null);
  const [persisted, setPersisted] = useState(false);
  const [supported, setSupported] = useState(false);

  const refresh = useCallback(async () => {
    const estimate = await estimateUsage();
    setUsage(estimate);

    const canPersist = typeof navigator !== 'undefined'
      && typeof navigator.storage?.persist === 'function';
    setSupported(canPersist);

    if (canPersist) {
      const granted = await requestPersistence();
      setPersisted(granted);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Re-seed the cache after an eviction.
   *
   * Called when the app notices the database is empty but the POI data was
   * already loaded from the network this session — which is exactly the
   * signature of iOS having cleared it overnight.
   */
  const reseedIfEvicted = useCallback(
    async (geojson) => {
      if (!geojson) return false;
      return cachePois(geojson);
    },
    [],
  );

  return {
    usage,
    persisted,
    supported,
    /** True when the browser is close to evicting this origin's data. */
    underPressure: usage?.quota
      ? usage.usage / usage.quota > 0.8
      : false,
    refresh,
    reseedIfEvicted,
    cacheUrl: PAI_URL,
  };
}
import { useCallback, useEffect, useState } from 'react';
import { estimateUsage, requestPersistence } from '../lib/offlineCache.js';

/**
 * Storage pressure and eviction.
 *
 * iOS evicts IndexedDB for sites a user has not visited in about seven days,
 * and it does so silently -- the next launch simply finds an empty database
 * with no error. The one real defence is to ask for persistent storage.
 *
 * `navigator.storage.persist()` only exists in Chromium. On Safari the request
 * is a no-op, so this is an optimisation and never a dependency.
 *
 * Deliberately thin. Detecting that the cache has already gone is `usePois`'s
 * job, because only it knows what it last wrote; duplicating that here led to
 * a second, doomed fetch of an origin that had already just failed.
 */
export function useStoragePressure() {
  const [usage, setUsage] = useState(null);
  const [persisted, setPersisted] = useState(false);
  const [supported, setSupported] = useState(false);

  const refresh = useCallback(async () => {
    setUsage(await estimateUsage());

    const canPersist = typeof navigator !== 'undefined'
      && typeof navigator.storage?.persist === 'function';
    setSupported(canPersist);

    if (canPersist) setPersisted(await requestPersistence());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    usage,
    persisted,
    supported,
    /** True when the browser is close to evicting this origin's data. */
    underPressure: usage?.quota ? usage.usage / usage.quota > 0.8 : false,
    refresh,
  };
}
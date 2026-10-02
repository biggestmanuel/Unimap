/**
 * IndexedDB cache for campus data and queued corrections.
 *
 * Ported in spirit from the legacy app's data-cache.js but rewritten: this
 * uses IndexedDB directly rather than the Cache API, because what needs
 * caching here is JSON we want to *read* with the same code path as a live
 * response, not opaque HTTP responses.
 *
 * Two stores:
 *  - `pois`       the campus directory, keyed by name
 *  - `corrections` reports queued while offline
 *
 * Everything degrades: if IndexedDB is unavailable (private mode, blocked),
 * these functions resolve rather than throw, because an offline cache is a
 * nice-to-have and must never be the reason the app fails to start.
 */

const DB_NAME = 'unimap';
const DB_VERSION = 1;
const STORE_POIS = 'pois';
const STORE_QUEUE = 'corrections';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_POIS)) {
        db.createObjectStore(STORE_POIS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const store = db.createObjectStore(STORE_QUEUE, {
          keyPath: 'id', autoIncrement: true,
        });
        store.createIndex('queuedAt', 'queuedAt');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── POIs ───────────────────────────────────────────────────────────────

/** Cache the POI directory. Best effort. */
export async function cachePois(geojson) {
  const db = await openDb();
  if (!db) return false;
  try {
    const store = tx(db, STORE_POIS, 'readwrite');
    await wrap(store.put({
      key: 'campus',
      savedAt: Date.now(),
      featureCount: geojson?.features?.length ?? 0,
      geojson,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The cached directory, or null.
 *
 * Returns the raw FeatureCollection so the caller runs it through exactly the
 * same normaliser as a live response -- a separate offline parsing path would
 * drift from the online one the first time either changed.
 */
export async function getCachedPois({ maxAgeMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const db = await openDb();
  if (!db) return null;
  try {
    const record = await wrap(tx(db, STORE_POIS, 'readonly').get('campus'));
    if (!record?.geojson) return null;
    if (Date.now() - record.savedAt > maxAgeMs) return null;
    return record;
  } catch {
    return null;
  }
}

// ── queued corrections ─────────────────────────────────────────────────

/** Queue a correction for later delivery. Returns false if it cannot be stored. */
export async function queueCorrection(payload) {
  const db = await openDb();
  if (!db) return false;
  try {
    await wrap(tx(db, STORE_QUEUE, 'readwrite').add({
      ...payload,
      queuedAt: Date.now(),
    }));
    return true;
  } catch {
    return false;
  }
}

export async function listQueued() {
  const db = await openDb();
  if (!db) return [];
  try {
    return await wrap(tx(db, STORE_QUEUE, 'readonly').getAll());
  } catch {
    return [];
  }
}

async function removeQueued(id) {
  const db = await openDb();
  if (!db) return;
  try {
    await wrap(tx(db, STORE_QUEUE, 'readwrite').delete(id));
  } catch {
    // Nothing useful to do; the item will retry.
  }
}

/**
 * Send everything queued.
 *
 * Each item is removed only after its POST succeeds, so a batch that half
 * fails does not lose the half that worked. A 4xx is treated as permanent
 * and dropped rather than retried forever -- a report that the server always
 * rejects is a bug, not a transient outage.
 */
export async function flushQueue({ base = '/api' } = {}) {
  const queued = await listQueued();
  const summary = { sent: 0, dropped: 0, failed: 0 };

  for (const item of queued) {
    try {
      const res = await fetch(`${base}/corrections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poiId: item.poiId,
          kind: item.kind,
          detail: item.detail,
          proposedName: item.proposedName,
          proposedLocation: item.proposedLocation,
          reporterEmail: item.reporterEmail,
          reporterDevice: item.reporterDevice,
        }),
      });

      if (res.status === 201) {
        await removeQueued(item.id);
        summary.sent += 1;
      } else if (res.status >= 400 && res.status < 500) {
        // Permanently unacceptable; stop retrying it.
        await removeQueued(item.id);
        summary.dropped += 1;
      } else {
        summary.failed += 1;
      }
    } catch {
      // Still offline.
      summary.failed += 1;
      break;
    }
  }

  return summary;
}

/** Approximate bytes used, for the storage-pressure notice. */
export async function estimateUsage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** Ask the browser not to evict us. Silently ignored where unsupported. */
export async function requestPersistence() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
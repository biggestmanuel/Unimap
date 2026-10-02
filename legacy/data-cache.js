/**
 * IndexedDB cache layer for persistent offline storage
 * Reduces network requests and improves load time significantly
 */

const DB_NAME = 'UniMapDB';
const DB_VERSION = 1;
const STORES = {
  locations: 'locations',
  events: 'events',
  metadata: 'metadata'
};

let db = null;

/**
 * Initialize IndexedDB
 */
async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      
      if (!database.objectStoreNames.contains(STORES.locations)) {
        database.createObjectStore(STORES.locations, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.events)) {
        database.createObjectStore(STORES.events, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.metadata)) {
        database.createObjectStore(STORES.metadata, { keyPath: 'key' });
      }
    };
  });
}

/**
 * Save data to IndexedDB
 */
async function cacheData(storeName, data, metadata = {}) {
  if (!db) await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName, STORES.metadata], 'readwrite');
    const store = tx.objectStore(storeName);
    const metaStore = tx.objectStore(STORES.metadata);

    // Clear old data
    store.clear();

    // Save records
    if (Array.isArray(data)) {
      data.forEach((item, i) => {
        store.add({ ...item, id: i });
      });
    } else {
      store.add({ ...data, id: 1 });
    }

    // Save metadata (timestamp, source)
    metaStore.put({
      key: storeName,
      timestamp: Date.now(),
      ...metadata
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve all data from a store
 */
async function getCachedData(storeName) {
  if (!db) await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => {
      const data = request.result;
      resolve(data && data.length > 0 ? data : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get cache metadata
 */
async function getCacheMetadata(storeName) {
  if (!db) await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.metadata], 'readonly');
    const store = tx.objectStore(STORES.metadata);
    const request = store.get(storeName);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Check if cached data is still fresh (< 6 hours old)
 */
async function isCacheFresh(storeName, maxAgeMs = 6 * 60 * 60 * 1000) {
  const meta = await getCacheMetadata(storeName);
  if (!meta) return false;
  return (Date.now() - meta.timestamp) < maxAgeMs;
}

/**
 * Clear all caches
 */
async function clearAllCache() {
  if (!db) await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(Object.values(STORES), 'readwrite');
    
    Object.values(STORES).forEach(storeName => {
      tx.objectStore(storeName).clear();
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

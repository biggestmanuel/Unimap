/**
 * Offline queue tests.
 *
 * Weighted towards the paths that lose data. A queued correction is a
 * student's report; anything that silently discards one is the worst bug
 * this codebase could ship.
 *
 * IndexedDB is stubbed with a small in-memory fake, because the point is the
 * queue logic, not the browser's storage engine.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/** Minimal IndexedDB double: enough for open/get/put/delete/add/getAll. */
function installFakeIndexedDb() {
  const stores = new Map();

  const makeRequest = (produce) => {
    const req = { onsuccess: null, onerror: null, result: undefined };
    setTimeout(() => {
      try {
        req.result = produce();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
    }, 0);
    return req;
  };

  const objectStore = (name) => ({
    put: (value) => makeRequest(() => {
      stores.get(name).set(value.key ?? value.id, value);
      return value.key ?? value.id;
    }),
    get: (key) => makeRequest(() => stores.get(name).get(key)),
    delete: (key) => makeRequest(() => stores.get(name).delete(key)),
    add: (value) => {
      const store = stores.get(name);
      const id = (store.__nextId = (store.__nextId ?? 0) + 1);
      const record = { ...value, id };
      return makeRequest(() => {
        store.set(id, record);
        return id;
      });
    },
    getAll: () => makeRequest(() => [...stores.get(name).values()]),
    createIndex: () => ({}),
  });

  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    // Called during onupgradeneeded; the store list is what contains()
    // reports, so creating one is just making sure the Map exists.
    createObjectStore: (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return objectStore(name);
    },
    transaction: (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return { objectStore: () => objectStore(name) };
    },
  };

  const open = () => {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      // The real API populates `result` before firing either callback.
      req.result = db;
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    value: { open },
    configurable: true,
  });

  return stores;
}

function removeIndexedDb() {
  delete globalThis.indexedDB;
}

const QUEUE_PAYLOAD = {
  poiId: '33333333-3333-4333-8333-333333333333',
  kind: 'detail',
  detail: 'the sign on this building has changed',
};

let flushQueue;
let listQueued;
let queueCorrection;

beforeEach(async () => {
  vi.resetModules();
  // Fresh module instance so the cached db handle is not reused between tests.
  const mod = await import('../src/lib/offlineCache.js');
  ({ flushQueue, listQueued, queueCorrection } = mod);
  installFakeIndexedDb();
});

afterEach(() => {
  removeIndexedDb();
  vi.restoreAllMocks();
});

// ── queueing ───────────────────────────────────────────────────────────
describe('queueCorrection', () => {
  it('stores a report and returns true', async () => {
    expect(await queueCorrection(QUEUE_PAYLOAD)).toBe(true);

    const queued = await listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0].detail).toBe(QUEUE_PAYLOAD.detail);
    expect(queued[0].queuedAt).toBeTypeOf('number');
  });

  it('returns false rather than throwing when IndexedDB is missing', async () => {
    // Regression: CorrectionForm treated a falsy return as success and told
    // the student their report was saved, then dropped it.
    removeIndexedDb();
    vi.resetModules();
    const mod = await import('../src/lib/offlineCache.js');

    expect(await mod.queueCorrection(QUEUE_PAYLOAD)).toBe(false);
  });
});

// ── flushing ───────────────────────────────────────────────────────────
describe('flushQueue', () => {
  it('sends and removes a queued report', async () => {
    await queueCorrection(QUEUE_PAYLOAD);

    globalThis.fetch = vi.fn(async () => ({ status: 201 }));
    const summary = await flushQueue();

    expect(summary.sent).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await listQueued()).toHaveLength(0);
  });

  it('KEEPS a rate-limited report instead of discarding it', async () => {
    // 429 is a 4xx. Treating "4xx means invalid" would have deleted a
    // student's report the moment they filed several in a row -- exactly what
    // the API rate limits for.
    await queueCorrection(QUEUE_PAYLOAD);

    globalThis.fetch = vi.fn(async () => ({
      status: 429,
      headers: { get: () => '15' },
    }));
    const summary = await flushQueue();

    expect(summary.sent).toBe(0);
    expect(summary.dropped).toBe(0, 'a 429 is not a rejection');
    expect(summary.retryAfter).toBe(15);
    expect(await listQueued()).toHaveLength(1, 'the report must survive');
  });

  it('keeps the report on a server error', async () => {
    await queueCorrection(QUEUE_PAYLOAD);

    globalThis.fetch = vi.fn(async () => ({ status: 503, headers: { get: () => null } }));
    const summary = await flushQueue();

    expect(summary.dropped).toBe(0);
    expect(await listQueued()).toHaveLength(1);
  });

  it('discards a genuinely invalid report', async () => {
    await queueCorrection(QUEUE_PAYLOAD);

    globalThis.fetch = vi.fn(async () => ({ status: 400, headers: { get: () => null } }));
    const summary = await flushQueue();

    expect(summary.dropped).toBe(1);
    expect(await listQueued()).toHaveLength(0);
  });

  it('keeps everything when still offline', async () => {
    await queueCorrection(QUEUE_PAYLOAD);

    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    const summary = await flushQueue();

    expect(summary.failed).toBe(1);
    expect(await listQueued()).toHaveLength(1);
  });

  it('stops at the first rate limit rather than hammering', async () => {
    await queueCorrection(QUEUE_PAYLOAD);
    await queueCorrection({ ...QUEUE_PAYLOAD, detail: 'second report here' });

    globalThis.fetch = vi.fn(async () => ({
      status: 429, headers: { get: () => '30' },
    }));
    await flushQueue();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1, 'should back off after one 429');
    expect(await listQueued()).toHaveLength(2);
  });

  it('does not send the internal queuedAt timestamp', async () => {
    await queueCorrection(QUEUE_PAYLOAD);

    globalThis.fetch = vi.fn(async () => ({ status: 201 }));
    await flushQueue();

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.queuedAt).toBeUndefined();
    expect(body.detail).toBe(QUEUE_PAYLOAD.detail);
  });

  it('is a no-op with an empty queue', async () => {
    globalThis.fetch = vi.fn();
    const summary = await flushQueue();

    expect(summary).toMatchObject({ sent: 0, dropped: 0, failed: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── graceful degradation ───────────────────────────────────────────────
describe('without IndexedDB', () => {
  it('reads report an empty queue rather than throwing', async () => {
    removeIndexedDb();
    vi.resetModules();
    const mod = await import('../src/lib/offlineCache.js');

    expect(await mod.listQueued()).toEqual([]);
    expect(await mod.getCachedPois()).toBeNull();
    expect(await mod.estimateUsage()).toBeNull();
    expect(await mod.requestPersistence()).toBe(false);
    expect(await mod.cachePois({ features: [] })).toBe(false);
  });
});
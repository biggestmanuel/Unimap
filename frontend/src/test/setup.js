import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node 22+ exposes a global `localStorage` getter that returns undefined
// unless --localstorage-file is set. That getter shadows jsdom's own storage
// implementation, so tests see no localStorage at all. Install a small
// in-memory Web Storage stand-in so behaviour is identical on every Node
// version. Only used in tests; the browser always provides the real thing.
class MemoryStorage {
  constructor() {
    this._items = new Map();
  }
  clear() {
    this._items.clear();
  }
  getItem(key) {
    const k = String(key);
    return this._items.has(k) ? this._items.get(k) : null;
  }
  setItem(key, value) {
    this._items.set(String(key), String(value));
  }
  removeItem(key) {
    this._items.delete(String(key));
  }
  key(index) {
    return [...this._items.keys()][index] ?? null;
  }
  get length() {
    return this._items.size;
  }
}

if (typeof globalThis.localStorage?.getItem !== 'function') {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom has no layout engine, so Leaflet's size-dependent code throws.
// Stubbing the measurements it needs lets component tests mount the map.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!Element.prototype.getBoundingClientRect.__leaflet_patched) {
  const patched = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 1024,
      height: 768,
      toJSON: () => ({}),
    };
  };
  patched.__leaflet_patched = true;
  Element.prototype.getBoundingClientRect = patched;
}
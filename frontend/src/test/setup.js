import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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
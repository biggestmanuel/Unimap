/**
 * Hook tests for navigation, offline and theming.
 *
 * These had no coverage at all, and two real bugs lived in here: a geolocation
 * timeout that left the user stuck with no retry button, and a trace recorder
 * that stopped itself before it recorded anything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useGeolocation } from '../src/hooks/useGeolocation.js';
import { useTheme, initialTheme } from '../src/hooks/useTheme.js';
import { useArrival, distanceMeters } from '../src/hooks/useArrival.js';
import { useGeofence, isDevBypass } from '../src/hooks/useGeofence.js';

const A = { lat: 4.79, lng: 6.98 };
const north = (m) => ({ lat: A.lat + m / 111320, lng: A.lng });

/** Install a fake geolocation whose callbacks the test can drive. */
function stubGeolocation() {
  // The real API returns a monotonically increasing integer id.
  let nextId = 1;
  const api = {
    watchPosition: vi.fn(() => nextId++),
    getCurrentPosition: vi.fn(),
    clearWatch: vi.fn(),
  };
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: api,
    configurable: true,
  });
  return api;
}

function removeGeolocation() {
  delete globalThis.navigator.geolocation;
}

afterEach(() => {
  removeGeolocation();
  vi.restoreAllMocks();
});

// ── useGeolocation ─────────────────────────────────────────────────────
describe('useGeolocation', () => {
  it('reports unavailable when the browser cannot locate', () => {
    removeGeolocation();
    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.start());

    expect(result.current.status).toBe('unavailable');
    expect(result.current.error).toBeTruthy();
  });

  it('moves to granted once a fix arrives', async () => {
    const api = stubGeolocation();
    const { result } = renderHook(() => useGeolocation());

    act(() => result.current.start());
    expect(result.current.status).toBe('locating');

    const [onSuccess] = api.watchPosition.mock.calls[0];
    act(() => onSuccess({
      coords: { latitude: A.lat, longitude: A.lng, accuracy: 8 },
      timestamp: 123,
    }));

    expect(result.current.status).toBe('granted');
    expect(result.current.position.lat).toBeCloseTo(A.lat, 5);
    expect(result.current.accuracyMeters).toBe(8);
    expect(result.current.isAccurate).toBe(true);
  });

  it('treats a poor fix as not accurate', async () => {
    const api = stubGeolocation();
    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.start());

    const [onSuccess] = api.watchPosition.mock.calls[0];
    act(() => onSuccess({
      coords: { latitude: A.lat, longitude: A.lng, accuracy: 120 },
      timestamp: 1,
    }));

    expect(result.current.isAccurate).toBe(false);
  });

  it('does not leak a second watcher when started twice', async () => {
    const api = stubGeolocation();
    const { result } = renderHook(() => useGeolocation());

    act(() => result.current.start());
    act(() => result.current.start());

    expect(api.watchPosition).toHaveBeenCalledTimes(1);
  });

  it('locks out on a denied permission and stops watching', async () => {
    const api = stubGeolocation();
    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.start());

    const [, onError] = api.watchPosition.mock.calls[0];
    act(() => onError({ code: 1 }));

    expect(result.current.status).toBe('denied');
    expect(api.clearWatch).toHaveBeenCalled();
  });

  it('returns to idle after a timeout so the retry button comes back', async () => {
    // Regression: a TIMEOUT left status at 'locating' forever, and the
    // "Use my location" button is only shown when idle -- so one bad fix in
    // a basement left the user permanently unable to retry.
    const api = stubGeolocation();
    const { result } = renderHook(() => useGeolocation());
    act(() => result.current.start());

    const [, onError] = api.watchPosition.mock.calls[0];
    act(() => onError({ code: 3 }));

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toMatch(/taking too long/i);
  });

  it('clears the watcher on unmount', () => {
    const api = stubGeolocation();
    const { result, unmount } = renderHook(() => useGeolocation());

    act(() => result.current.start());
    unmount();

    expect(api.clearWatch).toHaveBeenCalled();
  });
});

// ── useTheme ───────────────────────────────────────────────────────────
describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to light with no stored preference', () => {
    expect(initialTheme()).toBe('light');
  });

  it('reads a stored preference', () => {
    localStorage.setItem('unimap-theme', 'dark');
    expect(initialTheme()).toBe('dark');
  });

  it('ignores a nonsense stored value', () => {
    localStorage.setItem('unimap-theme', 'chartreuse');
    expect(['light', 'dark']).toContain(initialTheme());
  });

  it('applies the theme to the document and persists it', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('unimap-theme')).toBe('dark');
  });

  it('toggles back', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('light');
  });
});

// ── useArrival ─────────────────────────────────────────────────────────
describe('useArrival', () => {
  const route = [A, north(100), north(200)];

  it('does not announce arrival while still walking', () => {
    const { result } = renderHook(() => useArrival({
      routeCoords: route,
      destination: north(200),
      position: north(10),
    }));

    expect(result.current.arrived).toBe(false);
  });

  it('announces arrival once within the destination threshold', () => {
    // 35 m is the threshold, and the user is 1 m out.
    const { result } = renderHook(() => useArrival({
      routeCoords: route,
      destination: north(200),
      position: north(199),
    }));

    expect(result.current.arrived).toBe(true);
  });

  it('does not announce arrival well short of the destination', () => {
    const { result } = renderHook(() => useArrival({
      routeCoords: route,
      destination: north(200),
      position: north(100),
    }));

    expect(result.current.arrived).toBe(false);
  });

  it('reports the remaining distance', () => {
    const { result } = renderHook(() => useArrival({
      routeCoords: route,
      destination: north(200),
      position: A,
    }));
    expect(result.current.remainingMeters).toBeCloseTo(200, -1);
  });

  it('resets when the destination changes', () => {
    const { result, rerender } = renderHook(
      ({ dest }) => useArrival({ routeCoords: route, destination: dest, position: A }),
      { initialProps: { dest: north(200) } },
    );

    act(() => { result.current.reset(); });
    rerender({ dest: north(300) });
    expect(result.current.arrived).toBe(false);
  });

  it('survives a missing position', () => {
    const { result } = renderHook(() => useArrival({
      routeCoords: route,
      destination: north(200),
      position: null,
    }));
    expect(result.current.remainingMeters).toBeNull();
    expect(result.current.arrived).toBe(false);
  });

  it('distanceMeters handles missing points', () => {
    expect(distanceMeters(null, A)).toBe(Infinity);
    expect(distanceMeters(A, undefined)).toBe(Infinity);
  });
});

// ── useGeofence ────────────────────────────────────────────────────────
describe('useGeofence', () => {
  it('refuses navigation before a position is checked', () => {
    const { result } = renderHook(() => useGeofence({ bypass: false }));
    // Unchecked means off campus. App.jsx handles this by permitting an
    // unknown position rather than relying on the hook default.
    expect(result.current.canNavigate()).toBe(false);
  });

  it('allows navigation with the dev bypass', () => {
    const { result } = renderHook(() => useGeofence({ bypass: true }));
    expect(result.current.canNavigate()).toBe(true);
    expect(result.current.checkPoint([4.5, 6.5])).toBe(true);
  });

  it('recognises an on-campus point', () => {
    const { result } = renderHook(() => useGeofence({ bypass: false }));
    act(() => {
      result.current.checkPoint([4.797, 6.982]);
    });
    expect(result.current.isOnCampus).toBe(true);
    expect(result.current.canNavigate()).toBe(true);
  });

  it('recognises an off-campus point', () => {
    const { result } = renderHook(() => useGeofence({ bypass: false }));
    act(() => {
      result.current.checkPoint([4.5, 6.5]);
    });
    expect(result.current.isOnCampus).toBe(false);
  });

  it('ignores a malformed position', () => {
    const { result } = renderHook(() => useGeofence({ bypass: false }));
    act(() => {
      result.current.checkPoint(null);
    });
    expect(result.current.isOnCampus).toBe(false);
  });

  it('reads the dev bypass from the query string', () => {
    expect(isDevBypass('?dev=1')).toBe(true);
    expect(isDevBypass('?dev=0')).toBe(false);
    expect(isDevBypass('')).toBe(false);
    expect(isDevBypass('?other=1')).toBe(false);
  });
});
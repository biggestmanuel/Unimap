import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRouting } from './useRouting.js';

const RESPONSE = {
  found: true,
  mode: 'graph',
  coords: [{ lat: 4.79, lng: 6.98 }, { lat: 4.8, lng: 6.99 }],
  distanceMeters: 10,
  durationSeconds: 10,
  legs: [],
};

describe('useRouting retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resends the exact request that failed', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, json: async () => RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRouting());
    const from = { lat: 4.79, lng: 6.98 };
    const to = { lat: 4.8, lng: 6.99 };

    await act(async () => {
      await result.current.route(from, to, { maxSnapMeters: 50 });
    });
    expect(result.current.status).toBe('error');

    await act(async () => {
      await result.current.retry();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({ from, to, maxSnapMeters: 50 }),
    );
    expect(result.current.status).toBe('ready');
  });

  it('does nothing when no route has been requested yet', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { result } = renderHook(() => useRouting());

    await act(async () => {
      await result.current.retry();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});

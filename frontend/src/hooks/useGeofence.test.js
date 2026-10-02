import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGeofence, isDevBypass } from './useGeofence.js';
import { CAMPUS_CENTER } from '../lib/categories.js';

const ON_CAMPUS = [4.797, 6.982];
const OFF_CAMPUS = [4.75, 6.982];
const FAR_OFF = [6.5, 3.4]; // Lagos

describe('isDevBypass', () => {
  it('is on for ?dev=1', () => {
    expect(isDevBypass('?dev=1')).toBe(true);
  });

  it('is off for anything else', () => {
    expect(isDevBypass('')).toBe(false);
    expect(isDevBypass('?dev=0')).toBe(false);
    expect(isDevBypass('?dev=true')).toBe(false);
    expect(isDevBypass('?dev')).toBe(false);
    expect(isDevBypass('?other=1')).toBe(false);
  });
});

describe('useGeofence', () => {
  it('reports a campus position as inside', () => {
    const { result } = renderHook(() => useGeofence());
    act(() => {
      result.current.checkPoint(ON_CAMPUS);
    });
    expect(result.current.isOnCampus).toBe(true);
  });

  it('reports an off-campus position as outside', () => {
    const { result } = renderHook(() => useGeofence());
    act(() => {
      result.current.checkPoint(FAR_OFF);
    });
    expect(result.current.isOnCampus).toBe(false);
  });

  it('gates navigation off campus', () => {
    const { result } = renderHook(() => useGeofence());
    act(() => {
      result.current.checkPoint(OFF_CAMPUS);
    });
    expect(result.current.canNavigate()).toBe(false);

    act(() => {
      result.current.checkPoint(ON_CAMPUS);
    });
    expect(result.current.canNavigate()).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    const { result } = renderHook(() => useGeofence());
    act(() => {
      expect(result.current.checkPoint(null)).toBe(false);
      expect(result.current.checkPoint(undefined)).toBe(false);
      expect(result.current.checkPoint('somewhere')).toBe(false);
      expect(result.current.checkPoint([NaN, NaN])).toBe(false);
    });
  });

  it('tracks movement across the boundary', () => {
    const { result } = renderHook(() => useGeofence());
    act(() => result.current.checkPoint(ON_CAMPUS));
    expect(result.current.isOnCampus).toBe(true);
    act(() => result.current.checkPoint(FAR_OFF));
    expect(result.current.isOnCampus).toBe(false);
    act(() => result.current.checkPoint(ON_CAMPUS));
    expect(result.current.isOnCampus).toBe(true);
  });

  describe('with ?dev=1', () => {
    it('always considers the user on campus', () => {
      const { result } = renderHook(() => useGeofence({ bypass: true }));
      act(() => {
        expect(result.current.checkPoint(FAR_OFF)).toBe(true);
      });
    });

    it('never gates navigation', () => {
      const { result } = renderHook(() => useGeofence({ bypass: true }));
      expect(result.current.canNavigate()).toBe(true);
    });

    it('never flips isOnCampus', () => {
      const { result } = renderHook(() => useGeofence({ bypass: true }));
      act(() => result.current.checkPoint(FAR_OFF));
      expect(result.current.isOnCampus).toBe(false);
    });
  });

  it('accepts the exported campus centre', () => {
    const { result } = renderHook(() => useGeofence());
    act(() => {
      result.current.checkPoint(CAMPUS_CENTER);
    });
    expect(result.current.isOnCampus).toBe(true);
  });
});
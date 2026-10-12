import { describe, it, expect } from 'vitest';
import { tileStatus, tileHost, TILE_FAILURE_THRESHOLD } from '../src/lib/tileStatus.js';

/**
 * A tile request fails for two different reasons that look identical from the
 * map: the device is offline, or the tile server is refusing.
 *
 * Neither was handled before. `MapShell` had no `tileerror` listener at all, so
 * a throttled campus and a student in a basement both got a grey grid and
 * nothing else. The second is expected; the first means the shared public OSM
 * tile server has stopped serving this network, which is the failure
 * `docs/TILES.md` warns about and the one nobody notices.
 */

describe('tileHost', () => {
  it('names the host behind Leaflet subdomain templates', () => {
    expect(tileHost('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'))
      .toBe('a.tile.openstreetmap.org');
  });

  it('handles a plain single-host URL', () => {
    expect(tileHost('https://tiles.example.com/campus/{z}/{x}/{y}.png'))
      .toBe('tiles.example.com');
  });

  it('returns null rather than throwing on an unparseable template', () => {
    // Throwing inside a render would take the whole map down over a cosmetic
    // message. Null degrades to simply not naming the host.
    expect(tileHost('not a url')).toBeNull();
    expect(tileHost('')).toBeNull();
    expect(tileHost(undefined)).toBeNull();
  });
});

describe('tileStatus', () => {
  it('says nothing below the threshold', () => {
    // A campus viewport loads a dozen tiles. A transient blip is not a problem
    // and a banner that cries wolf gets ignored.
    expect(tileStatus(0, true)).toBeNull();
    expect(tileStatus(TILE_FAILURE_THRESHOLD - 1, true)).toBeNull();
  });

  it('blames the server when online and tiles are failing', () => {
    const status = tileStatus(TILE_FAILURE_THRESHOLD, true);
    expect(status?.kind).toBe('blocked');
    expect(status.message).toMatch(/refusing requests/i);
    // The actionable half: name the likely cause, because "the map is broken"
    // is what this replaces.
    expect(status.message).toMatch(/throttl/i);
  });

  it('blames the network when offline, and does not accuse the server', () => {
    const status = tileStatus(TILE_FAILURE_THRESHOLD, false);
    expect(status?.kind).toBe('offline');
    expect(status.message).toMatch(/offline/i);
    expect(status.message).not.toMatch(/throttl/i);
  });

  it('makes clear the app still works when tiles are refused', () => {
    const status = tileStatus(TILE_FAILURE_THRESHOLD, true);
    expect(status.message).toMatch(/still work/i);
  });

  it('reports nothing once failures clear', () => {
    expect(tileStatus(0, false)).toBeNull();
    expect(tileStatus(0, true)).toBeNull();
  });
});
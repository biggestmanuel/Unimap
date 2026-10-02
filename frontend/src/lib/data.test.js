import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { normalizeCollection, resolvePopularPlaces } from './pois.js';
import { isPointInPolygon } from './geo.js';
import { CATEGORIES, RSU_CAMPUS_POLYGON, POPULAR_PLACES } from './categories.js';

/**
 * Integration tests against the real campus data file.
 * These are the ones that catch bad coordinates and dead chips, which
 * unit tests with invented fixtures never would.
 */
const raw = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/data/unimap.geojson'), 'utf8'),
);
const pois = normalizeCollection(raw);

describe('unimap.geojson', () => {
  it('is a FeatureCollection', () => {
    expect(raw.type).toBe('FeatureCollection');
    expect(Array.isArray(raw.features)).toBe(true);
  });

  it('yields 79 usable POIs', () => {
    expect(pois).toHaveLength(79);
  });

  it('drops no features silently', () => {
    const dropped = raw.features.length - pois.length;
    expect(dropped, `${dropped} features were discarded`).toBe(0);
  });

  it('gives every POI a unique id', () => {
    const ids = new Set(pois.map((p) => p.id));
    expect(ids.size).toBe(pois.length);
  });

  it('has no duplicate names', () => {
    const names = new Set(pois.map((p) => p.name));
    expect(names.size).toBe(pois.length);
  });

  it('keeps every coordinate inside the campus boundary', () => {
    const outside = pois.filter((p) => !isPointInPolygon(p.position, RSU_CAMPUS_POLYGON));
    expect(outside.map((p) => p.name), 'POIs outside the campus polygon').toEqual([]);
  });

  it('has no null-island coordinates', () => {
    expect(pois.filter((p) => p.lat === 0 && p.lng === 0)).toHaveLength(0);
  });

  it('resolves every POI to a registered category', () => {
    const unknown = pois.filter((p) => !CATEGORIES[p.category]);
    expect(unknown.map((p) => `${p.name}: ${p.category}`)).toEqual([]);
  });

  it('keeps the whole set in one tight campus cluster', () => {
    const lats = pois.map((p) => p.lat);
    const lngs = pois.map((p) => p.lng);
    expect(Math.max(...lats) - Math.min(...lats)).toBeLessThan(0.05); // ~5.5 km
    expect(Math.max(...lngs) - Math.min(...lngs)).toBeLessThan(0.05);
  });

  it('resolves every popular-place chip', () => {
    const { resolved, unresolved } = resolvePopularPlaces(pois);
    expect(unresolved, 'unresolved popular places').toEqual([]);
    expect(resolved).toHaveLength(POPULAR_PLACES.length);
  });
});
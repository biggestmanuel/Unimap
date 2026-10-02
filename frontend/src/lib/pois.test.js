import { describe, it, expect } from 'vitest';
import {
  normalizeFeature,
  normalizeCollection,
  scorePoi,
  searchPois,
  filterByCategory,
  categoryCounts,
  resolvePopularPlaces,
  slugify,
} from './pois.js';

const feature = (name, category, coords = [6.98, 4.79], extra = {}) => ({
  type: 'Feature',
  properties: { Name: name, category, ...extra },
  geometry: { type: 'Point', coordinates: coords },
});

describe('normalizeFeature', () => {
  it('converts [lng, lat] to [lat, lng]', () => {
    const poi = normalizeFeature(feature('NEH', 'academic', [6.9795, 4.7961]));
    expect(poi.position).toEqual([4.7961, 6.9795]);
    expect(poi.lat).toBeCloseTo(4.7961, 6);
    expect(poi.lng).toBeCloseTo(6.9795, 6);
  });

  it('normalises the category key', () => {
    // The real data contains "laboratory " with a trailing space.
    expect(normalizeFeature(feature('Lab', 'laboratory ')).category).toBe('laboratory');
  });

  it('falls back to "other" for unknown categories', () => {
    expect(normalizeFeature(feature('X', 'spaceport')).category).toBe('other');
    expect(normalizeFeature(feature('X', undefined)).category).toBe('other');
  });

  it('accepts lowercase name as a fallback', () => {
    const f = feature('Ignored', 'academic');
    f.properties = { name: 'Lowercase Name' };
    expect(normalizeFeature(f).name).toBe('Lowercase Name');
  });

  it('rejects unplaceable features without throwing', () => {
    expect(normalizeFeature(null)).toBeNull();
    expect(normalizeFeature({ type: 'NotAFeature' })).toBeNull();
    expect(normalizeFeature({ type: 'Feature', properties: { Name: 'A' }, geometry: null })).toBeNull();
    expect(normalizeFeature({ type: 'Feature', properties: null, geometry: null })).toBeNull();
  });

  it('rejects null island coordinates', () => {
    expect(normalizeFeature(feature('Nowhere', 'academic', [0, 0]))).toBeNull();
  });

  it('rejects non-numeric coordinates', () => {
    const f = feature('Bad', 'academic');
    f.geometry.coordinates = ['a', 'b'];
    expect(normalizeFeature(f)).toBeNull();
  });

  it('rejects unnamed features', () => {
    const f = feature('   ', 'academic');
    expect(normalizeFeature(f)).toBeNull();
  });

  it('gives every POI an id', () => {
    const a = normalizeFeature(feature('Love Garden', 'landmark'), 0);
    const b = normalizeFeature(feature('Love Garden', 'landmark'), 1);
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});

describe('normalizeCollection', () => {
  it('drops unusable features but keeps the rest', () => {
    const collection = {
      features: [feature('Good', 'academic'), null, feature('', 'academic')],
    };
    const pois = normalizeCollection(collection);
    expect(pois).toHaveLength(1);
    expect(pois[0].name).toBe('Good');
  });

  it('tolerates a completely malformed payload', () => {
    expect(normalizeCollection(null)).toEqual([]);
    expect(normalizeCollection({})).toEqual([]);
  });
});

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('F&G hostel')).toBe('f-g-hostel');
    expect(slugify('CCE(Centre for Continuous Education)')).toBe(
      'cce-centre-for-continuous-education',
    );
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('  ...Hello World!!!  ')).toBe('hello-world');
  });
});

describe('scorePoi', () => {
  const poi = {
    name: 'Faculty of Engineering',
    searchName: 'faculty of engineering',
    categoryLabel: 'Faculty',
  };

  it('returns 0 for no match', () => {
    expect(scorePoi(poi, 'zzzz')).toBe(0);
  });

  it('returns 1 for an empty query', () => {
    expect(scorePoi(poi, '')).toBe(1);
    expect(scorePoi(poi, '   ')).toBe(1);
  });

  it('ranks a name prefix above a substring', () => {
    const prefix = scorePoi(poi, 'faculty');
    const substring = scorePoi(poi, 'engineering');
    expect(prefix).toBeGreaterThan(substring);
  });

  it('matches a word prefix', () => {
    expect(scorePoi(poi, 'eng')).toBeGreaterThan(0);
  });

  it('matches multi-token queries', () => {
    expect(scorePoi(poi, 'fac eng')).toBeGreaterThan(0);
  });

  it('falls back to the category label', () => {
    expect(scorePoi(poi, 'facult')).toBeGreaterThan(0);
  });

  it('is case insensitive', () => {
    expect(scorePoi(poi, 'FACULTY')).toBe(scorePoi(poi, 'faculty'));
  });
});

describe('searchPois', () => {
  const pois = normalizeCollection({
    features: [
      feature('Faculty of Engineering', 'faculty'),
      feature('Faculty of Law', 'faculty'),
      feature('NEH', 'academic'),
      feature('Hostel A', 'hostel'),
    ],
  });

  it('returns [] for an empty query so the sheet can show chips', () => {
    expect(searchPois(pois, '')).toEqual([]);
    expect(searchPois(pois, '   ')).toEqual([]);
  });

  it('ranks the tighter prefix match first', () => {
    // Both are prefix matches on "fac", so the shorter name wins: a more
    // specific hit should outrank a longer name that merely starts the same.
    const r = searchPois(pois, 'fac');
    expect(r).toHaveLength(2);
    expect(r.map((p) => p.name)).toEqual(['Faculty of Law', 'Faculty of Engineering']);
  });

  it('falls back to alphabetical order for equal scores', () => {
    const sameLength = normalizeCollection({
      features: [feature('Alpha Hall', 'academic'), feature('Beta Hall', 'academic')],
    });
    expect(searchPois(sameLength, 'a').map((p) => p.name)).toEqual(['Alpha Hall', 'Beta Hall']);
  });

  it('honours the category filter', () => {
    const r = searchPois(pois, 'fac', { category: 'hostel' });
    expect(r).toHaveLength(0);
  });

  it('respects the limit', () => {
    expect(searchPois(pois, 'faculty', { limit: 1 })).toHaveLength(1);
  });

  it('returns [] when nothing matches', () => {
    expect(searchPois(pois, 'qqqq')).toEqual([]);
  });
});

describe('filterByCategory', () => {
  const pois = normalizeCollection({
    features: [feature('A', 'faculty'), feature('B', 'hostel'), feature('C', 'faculty')],
  });

  it('passes everything through with no category', () => {
    expect(filterByCategory(pois, null)).toHaveLength(3);
  });

  it('filters to one category', () => {
    expect(filterByCategory(pois, 'faculty')).toHaveLength(2);
  });

  it('returns [] for an unused category', () => {
    expect(filterByCategory(pois, 'spaceport')).toHaveLength(0);
  });
});

describe('categoryCounts', () => {
  it('counts and orders by population', () => {
    const pois = normalizeCollection({
      features: [
        feature('A', 'hostel'),
        feature('B', 'hostel'),
        feature('C', 'faculty'),
        feature('D', 'other'),
      ],
    });
    const counts = categoryCounts(pois);
    expect(counts[0]).toMatchObject({ category: 'hostel', count: 2 });
    expect(counts.map((c) => c.count)).toEqual([...counts.map((c) => c.count)].sort((a, b) => b - a));
    expect(counts[0].label).toBe('Hostel');
  });

  it('is empty for no POIs', () => {
    expect(categoryCounts([])).toEqual([]);
  });
});

describe('resolvePopularPlaces', () => {
  it('resolves exact names', () => {
    const pois = normalizeCollection({ features: [feature('Love Garden', 'landmark')] });
    const { resolved } = resolvePopularPlaces(pois);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].poi.name).toBe('Love Garden');
  });

  it('applies the short display label', () => {
    const pois = normalizeCollection({
      features: [feature('Convocation Arena', 'landmark')],
    });
    expect(resolvePopularPlaces(pois).resolved[0].label).toBe('Convo Arena');
  });

  it('reports names it could not resolve instead of hiding them', () => {
    // This is the class of bug that made the legacy chips silently dead.
    const { resolved, unresolved } = resolvePopularPlaces([]);
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(15);
    expect(unresolved).toContain('Love Garden');
  });
});
/**
 * POI normalisation, searching and filtering.
 * Pure functions — the geojson boundary lives here and nowhere else.
 */

import { normalizeCategory, categoryMeta, POPULAR_PLACES, POPULAR_LABELS } from './categories.js';

/**
 * GeoJSON Feature -> app shape.
 *
 * GeoJSON coordinates are [lng, lat]; the app works in [lat, lng].
 * Returns null for anything we cannot place on the map, so a single bad
 * row cannot take the whole directory down.
 */
export function normalizeFeature(feature, index = 0) {
  if (!feature || feature.type !== 'Feature') return null;

  const geometry = feature.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;

  const [lng, lat] = geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null; // null island = missing data

  const props = feature.properties ?? {};
  const name = String(props.Name ?? props.name ?? '').trim();
  if (!name) return null;

  const category = normalizeCategory(props.category);

  return {
    id: props.id ?? `${slugify(name)}-${index}`,
    name,
    searchName: name.toLowerCase(),
    category,
    categoryLabel: categoryMeta(category).label,
    description: props.indoorDescription ?? props.description ?? null,
    accessibility: Array.isArray(props.accessibility) ? props.accessibility : [],
    safety: props.safety === true,
    position: [lat, lng],
    lat,
    lng,
  };
}

/** FeatureCollection -> POI array, dropping unusable features. */
export function normalizeCollection(geojson) {
  const features = geojson?.features ?? [];
  return features.map(normalizeFeature).filter(Boolean);
}

export function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Score a POI against a lowercase query. Higher is better, 0 is no match.
 *
 * Ranking is deliberate: a prefix match on the whole name beats a
 * prefix match on one word, which beats a substring match anywhere.
 */
export function scorePoi(poi, query) {
  if (!query) return 1;
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const name = poi.searchName;
  if (name.startsWith(q)) return 1000 - name.length;

  const words = name.split(/[\s(),/-]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(q)) return 700 - i * 10 - name.length;
  }

  // "fac eng" style multi-token queries.
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => name.includes(t))) {
    return 500 - name.length;
  }

  if (name.includes(q)) return 300 - name.length;
  if (poi.categoryLabel.toLowerCase().includes(q)) return 120;

  return 0;
}

/** Ranked search results. An empty query returns [] so the sheet shows chips instead. */
export function searchPois(pois, query, { limit = 40, category = null } = {}) {
  const pool = category ? pois.filter((p) => p.category === category) : pois;
  if (!query || !query.trim()) return [];

  return pool
    .map((poi) => ({ poi, score: scorePoi(poi, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.poi.name.localeCompare(b.poi.name))
    .slice(0, limit)
    .map((r) => r.poi);
}

export function filterByCategory(pois, category) {
  if (!category) return pois;
  return pois.filter((p) => p.category === category);
}

/** Category chips, most-populated first so the useful ones lead. */
export function categoryCounts(pois) {
  const counts = new Map();
  for (const p of pois) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count, ...categoryMeta(category) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Resolve POPULAR_PLACES against real POIs.
 *
 * The legacy code matched these by exact string, which silently produced
 * dead chips whenever the geojson drifted. This matches case- and
 * punctuation-insensitively and reports what failed to resolve, so
 * missing entries are visible instead of invisible.
 */
export function resolvePopularPlaces(pois) {
  const byKey = new Map();
  for (const p of pois) byKey.set(p.searchName, p);

  const resolved = [];
  const unresolved = [];

  for (const name of POPULAR_PLACES) {
    const poi = byKey.get(name.toLowerCase()) ?? byKey.get(slugify(name));
    if (poi) {
      resolved.push({ poi, label: POPULAR_LABELS[name] ?? poi.name, sourceName: name });
    } else {
      unresolved.push(name);
    }
  }

  return { resolved, unresolved };
}
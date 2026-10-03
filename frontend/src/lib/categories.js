/**
 * Category registry and campus geometry constants.
 * Ported verbatim from legacy/unimap.js so the two apps render identically.
 */

/** label + colour + emoji for every known category key. */
export const CATEGORIES = {
  academic: { label: 'Academic', color: '#2563EB', icon: '📚' },
  'lecture-hall': { label: 'Lecture Hall', color: '#4F46E5', icon: '🏛️' },
  laboratory: { label: 'Laboratory', color: '#0D9488', icon: '🧪' },
  department: { label: 'Department', color: '#1D4ED8', icon: '🧑‍🏫' },
  faculty: { label: 'Faculty', color: '#7C3AED', icon: '🏢' },
  hostel: { label: 'Hostel', color: '#F59E0B', icon: '🏠' },
  sports: { label: 'Sports', color: '#10B981', icon: '⚽' },
  bank: { label: 'Bank', color: '#059669', icon: '🏦' },
  admin: { label: 'Admin', color: '#0891B2', icon: '🏢' },
  church: { label: 'Church', color: '#9333EA', icon: '⛪' },
  medical: { label: 'Medical', color: '#EF4444', icon: '⛑️' },
  library: { label: 'Library', color: '#2563EB', icon: '📖' },
  transit: { label: 'Transit', color: '#6B7280', icon: '🚌' },
  amenity: { label: 'Amenity', color: '#D97706', icon: '🛍️' },
  eatery: { label: 'Eatery', color: '#EA580C', icon: '🍽️' },
  landmark: { label: 'Landmark', color: '#DB2777', icon: '📍' },
  other: { label: 'Other', color: '#64748B', icon: '📌' },
};

export const FALLBACK_CATEGORY = CATEGORIES.other;

/**
 * The source data contains whitespace-only bugs (e.g. "laboratory ").
 * Normalising at the boundary means everything downstream can assume
 * a clean, trimmed key that exists in CATEGORIES.
 */
export function normalizeCategory(raw) {
  if (typeof raw !== 'string') return 'other';
  const key = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return key in CATEGORIES ? key : 'other';
}

export function categoryMeta(key) {
  return CATEGORIES[key] ?? FALLBACK_CATEGORY;
}

/**
 * Campus boundary as an explicitly closed [lat, lng] ring.
 * The ray-casting test tolerates an unclosed ring, but closing it here
 * means the buffer pass also measures the final edge.
 */
export const RSU_CAMPUS_POLYGON = [
  [4.808, 6.99],
  [4.808, 6.972],
  [4.788, 6.972],
  [4.788, 6.99],
  [4.808, 6.99],
];

export const GEOFENCE_BUFFER_METERS = 100;

/** Map centre and a zoom that frames the whole campus. */
export const CAMPUS_CENTER = [4.797, 6.982];
export const CAMPUS_ZOOM = 16;
export const CAMPUS_NAME = 'Rivers State University';

export const POPULAR_PLACES = [
  'UST Shuttle Park',
  'Convocation Arena',
  'Faculty of Management Sciences',
  'FACULTY OF ENGINEERING',
  'Faculty of Law, Rivers State University',
  'F&G hostel',
  'NDDC Hostel',
  'Hostel C',
  'Shopping Complex',
  'Love Garden',
  'PG&H Hostel',
  'Back Gate Shuttle Park',
  'UST Back Gate',
  'CCE(Centre for Continuous Education)',
  'College of Medical Sciences, RSU',
];

export const POPULAR_LABELS = {
  'UST Shuttle Park': 'Shuttle Park',
  'Convocation Arena': 'Convo Arena',
  'Faculty of Management Sciences': 'Management',
  'FACULTY OF ENGINEERING': 'Engineering',
  'Faculty of Law, Rivers State University': 'Law Faculty',
  'F&G hostel': 'F&G Hostel',
  'NDDC Hostel': 'NDDC Hostel',
  'Hostel C': 'Hostel C',
  'Shopping Complex': 'Shopping Complex',
  'Love Garden': 'Love Garden',
  'PG&H Hostel': 'PG&H Hostel',
  'Back Gate Shuttle Park': 'Back Gate Park',
  'UST Back Gate': 'Back Gate',
  'CCE(Centre for Continuous Education)': 'CCE',
  'College of Medical Sciences, RSU': 'Med Sciences',
};
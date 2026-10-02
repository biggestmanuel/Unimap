import { z } from 'zod';

/**
 * Request validation. Pure — no Express, no DB. Every route parses
 * through these so a malformed or hostile submission is rejected at the
 * boundary rather than reaching PostGIS.
 */

export const CATEGORIES = [
  'academic',
  'lecture-hall',
  'laboratory',
  'department',
  'faculty',
  'hostel',
  'sports',
  'bank',
  'admin',
  'church',
  'medical',
  'library',
  'transit',
  'amenity',
  'eatery',
  'landmark',
  'other',
];

/** GeoJSON order. The API speaks [lng, lat] so clients need no translation. */
const lngLat = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/** The same thing as a positional pair, for array-shaped payloads. */
const lngLatPair = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

export const listPoisQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  category: z.enum(CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const poiIdParam = z.object({
  id: z.string().uuid('must be a POI uuid'),
});

/**
 * A student correction submission.
 *
 * `kind` drives which fields are meaningful, and the refinement below
 * rejects incoherent combinations — e.g. claiming to move a POI without
 * saying where it moved to.
 */
export const createCorrectionSchema = z
  .object({
    poiId: z.string().uuid().optional(),
    kind: z.enum(['moved', 'renamed', 'removed', 'created', 'detail']),
    detail: z.string().trim().min(5, 'please say what is wrong').max(2000),

    proposedName: z.string().trim().min(1).max(200).optional(),
    proposedCategory: z.enum(CATEGORIES).optional(),
    proposedLocation: lngLat.optional(),

    reporterEmail: z.string().email().max(200).optional(),
    reporterDevice: z.string().trim().max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'created' && !value.proposedName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedName'],
        message: 'a new location needs a name',
      });
    }

    if (value.kind === 'created' && !value.proposedLocation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedLocation'],
        message: 'a new location needs coordinates',
      });
    }

    if (value.kind === 'moved' && !value.proposedLocation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedLocation'],
        message: 'say where it actually is',
      });
    }

    if (value.kind === 'renamed' && !value.proposedName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedName'],
        message: 'say what it should be called',
      });
    }

    if (value.kind !== 'created' && !value.poiId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['poiId'],
        message: 'pick the location you are correcting',
      });
    }
  });

export const listCorrectionsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const reviewCorrectionSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(1000).optional(),
  reviewer: z.string().trim().min(1).max(200),
});

/**
 * A point on the map, or a reference to a seeded POI.
 *
 * Accepting either matters in practice: the app sends a POI id when the user
 * taps a marker and a raw GPS fix when they are already standing there.
 */
export const routeEndpointSchema = z.union([
  lngLat,
  z.object({ poiId: z.string().uuid() }).strict(),
]);

export const routeSchema = z.object({
  from: routeEndpointSchema,
  to: routeEndpointSchema,
  /**
   * How far from a path we will still route. Tight by default: snapping
   * something 200 m onto a road produces confident nonsense.
   */
  maxSnapMeters: z.number().min(1).max(200).default(50),
  walkSpeedMps: z.number().min(0.5).max(3).default(1.35),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

/**
 * Admin user creation.
 *
 * Only reachable by an authenticated admin, so there is no separate
 * "invite code" flow — but the role is constrained by the enum rather than
 * by trusting the client to send 'student'.
 */
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().trim().min(1).max(200).optional(),
  role: z.enum(['student', 'admin']).default('student'),
  password: z.string().min(10, 'use at least 10 characters').max(200),
});

/**
 * A student-submitted walk trace.
 *
 * Points are [lng, lat] to match the rest of the API. Bounds are enforced
 * here because a trace is the one submission large enough to be a real
 * denial-of-service risk: unbounded input here would be a few megabytes of
 * JSON per request.
 */
export const traceSchema = z.object({
  points: z
    .array(lngLatPair)
    .min(2, 'a trace needs at least two points')
    .max(20000, 'that trace is too long'),
  note: z.string().trim().max(500).optional(),
  reporterDevice: z.string().trim().max(100).optional(),
});

export const listTracesQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'merged']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const reviewTraceSchema = z.object({
  status: z.enum(['approved', 'rejected', 'merged']),
  note: z.string().trim().max(1000).optional(),
  reviewer: z.string().trim().min(1).max(200),
});

export const graphStatsQuery = z.object({
  /** Include the per-island breakdown, which is the useful bit. */
  islands: z.enum(['true', 'false']).default('true'),
});

/** Flatten a ZodError into a stable { field: message } map for JSON output. */
export function formatIssues(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
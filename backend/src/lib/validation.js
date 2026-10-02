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

/** Flatten a ZodError into a stable { field: message } map for JSON output. */
export function formatIssues(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
import { describe, it } from 'node:test';
import { expect } from './expect.js';
import {
  listPoisQuery,
  createCorrectionSchema,
  listCorrectionsQuery,
  reviewCorrectionSchema,
  formatIssues,
  CATEGORIES,
} from '../src/lib/validation.js';

const fields = (schema, value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? null : formatIssues(parsed.error);
};

describe('listPoisQuery', () => {
  it('defaults limit and offset', () => {
    const parsed = listPoisQuery.parse({});
    expect(parsed.limit).toBe(200);
    expect(parsed.offset).toBe(0);
  });

  it('coerces numeric strings from the query string', () => {
    const parsed = listPoisQuery.parse({ limit: '10', offset: '20' });
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(20);
  });

  it('caps the limit so one request cannot pull the whole table', () => {
    expect(listPoisQuery.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(listPoisQuery.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('rejects an unknown category', () => {
    expect(listPoisQuery.safeParse({ category: 'spaceport' }).success).toBe(false);
  });

  it('accepts every registered category', () => {
    for (const category of CATEGORIES) {
      expect(listPoisQuery.safeParse({ category }).success, category).toBe(true);
    }
  });

  it('trims the search term', () => {
    expect(listPoisQuery.parse({ q: '  engineering  ' }).q).toBe('engineering');
  });

  it('rejects an over-long search term', () => {
    expect(listPoisQuery.safeParse({ q: 'x'.repeat(500) }).success).toBe(false);
  });
});

describe('createCorrectionSchema', () => {
  const poiId = '11111111-1111-4111-8111-111111111111';

  it('accepts a "moved" correction', () => {
    expect(
      createCorrectionSchema.safeParse({
        poiId,
        kind: 'moved',
        detail: 'The gate moved during construction',
        proposedLocation: { lat: 4.797, lng: 6.982 },
      }).success,
    ).toBe(true);
  });

  it('accepts a "detail" correction with only prose', () => {
    expect(
      createCorrectionSchema.safeParse({
        poiId,
        kind: 'detail',
        detail: 'The library now closes at 6pm, not 8pm',
      }).success,
    ).toBe(true);
  });

  it('accepts a "created" correction', () => {
    expect(
      createCorrectionSchema.safeParse({
        kind: 'created',
        detail: 'New hostel block behind the faculty',
        proposedName: 'Hostel D',
        proposedLocation: { lat: 4.798, lng: 6.983 },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(
      createCorrectionSchema.safeParse({ poiId, kind: 'vandalise', detail: 'nope' }).success,
    ).toBe(false);
  });

  it('rejects a too-short detail', () => {
    expect(fields(createCorrectionSchema, { poiId, kind: 'detail', detail: 'no' })).toMatchObject({
      detail: 'please say what is wrong',
    });
  });

  it('requires coordinates for a moved correction', () => {
    expect(
      fields(createCorrectionSchema, { poiId, kind: 'moved', detail: 'it is over there' }),
    ).toMatchObject({ proposedLocation: 'say where it actually is' });
  });

  it('requires a name for a created correction', () => {
    expect(
      fields(createCorrectionSchema, {
        kind: 'created',
        detail: 'new building',
        proposedLocation: { lat: 4.8, lng: 6.98 },
      }),
    ).toMatchObject({ proposedName: 'a new location needs a name' });
  });

  it('requires coordinates for a created correction', () => {
    expect(
      fields(createCorrectionSchema, {
        kind: 'created',
        detail: 'new building',
        proposedName: 'Hostel D',
      }),
    ).toMatchObject({ proposedLocation: 'a new location needs coordinates' });
  });

  it('requires a poiId for every kind except "created"', () => {
    for (const kind of ['moved', 'renamed', 'removed', 'detail']) {
      expect(
        fields(createCorrectionSchema, { kind, detail: 'something is off here' }),
        kind,
      ).toMatchObject({ poiId: 'pick the location you are correcting' });
    }
  });

  it('rejects an out-of-range coordinate', () => {
    expect(
      createCorrectionSchema.safeParse({
        poiId,
        kind: 'moved',
        detail: 'wrong map',
        proposedLocation: { lat: 999, lng: 6.98 },
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(
      fields(createCorrectionSchema, {
        poiId,
        kind: 'detail',
        detail: 'note about this place',
        reporterEmail: 'not-an-email',
      }),
    ).toMatchObject({ reporterEmail: expect.any(String) });
  });

  it('rejects a non-uuid poiId', () => {
    expect(
      createCorrectionSchema.safeParse({ poiId: 'abc', kind: 'detail', detail: 'hello there' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown proposed category', () => {
    expect(
      fields(createCorrectionSchema, {
        poiId,
        kind: 'detail',
        detail: 'this should be a lab',
        proposedCategory: 'laboratoryy',
      }),
    ).toMatchObject({ proposedCategory: expect.any(String) });
  });
});

describe('listCorrectionsQuery', () => {
  it('defaults to the pending queue', () => {
    expect(listCorrectionsQuery.parse({}).status).toBe('pending');
  });

  it('rejects an unknown status', () => {
    expect(listCorrectionsQuery.safeParse({ status: 'maybe' }).success).toBe(false);
  });
});

describe('reviewCorrectionSchema', () => {
  it('does not require a reviewer in the body', () => {
    // The reviewer now comes from the authenticated session, so requiring it in
    // the request body would only invite a client to send a forged one. See
    // routes/corrections.js.
    expect(reviewCorrectionSchema.safeParse({ status: 'approved' }).success).toBe(true);
  });

  it('still accepts a reviewer, which the route discards', () => {
    expect(reviewCorrectionSchema.safeParse({ status: 'approved', reviewer: 'admin' }).success).toBe(
      true,
    );
  });

  it('accepts approve and reject', () => {
    expect(reviewCorrectionSchema.safeParse({ status: 'approved', reviewer: 'admin' }).success).toBe(
      true,
    );
    expect(reviewCorrectionSchema.safeParse({ status: 'rejected', reviewer: 'admin' }).success).toBe(
      true,
    );
  });

  it('does not accept "pending" as a review outcome', () => {
    expect(reviewCorrectionSchema.safeParse({ status: 'pending', reviewer: 'admin' }).success).toBe(
      false,
    );
  });
});

describe('formatIssues', () => {
  it('flattens to field -> message', () => {
    const parsed = createCorrectionSchema.safeParse({ kind: 'moved', detail: 'x' });
    const out = formatIssues(parsed.error);
    expect(out.detail).toBe('please say what is wrong');
    expect(out.poiId).toBeTruthy();
  });
});
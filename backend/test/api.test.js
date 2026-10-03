import { describe, it } from 'node:test';
import { expect } from './expect.js';
import request from 'supertest';
import createApp from '../src/app.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';

const SEED = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'NEH',
    category: 'academic',
    description: 'Main lecture hall block',
    lat: 4.796,
    lng: 6.9795,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Faculty of Engineering',
    category: 'faculty',
    lat: 4.79,
    lng: 6.98,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Hostel A',
    category: 'hostel',
    lat: 4.791,
    lng: 6.981,
  },
];

const NEH = SEED[0].id;

function makeApp() {
  // Each test builds a fresh app, so clear the shared rate-limit buckets too.
  // Otherwise a file that submits many corrections throttles itself partway
  // through and the failure looks like a routing bug.
  resetAllLimiters();
  return createApp({ repo: createMemoryRepo(SEED), requireAdmin: (req, res, next) => next() });
}

describe('GET /health', () => {
  it('reports ok', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/pois', () => {
  it('lists every POI by default', async () => {
    const res = await request(makeApp()).get('/api/pois');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(3);
  });

  it('filters by category', async () => {
    const res = await request(makeApp()).get('/api/pois?category=hostel');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].name).toBe('Hostel A');
  });

  it('searches case-insensitively', async () => {
    const res = await request(makeApp()).get('/api/pois?q=neh');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].name).toBe('NEH');
  });

  it('matches on description too', async () => {
    const res = await request(makeApp()).get('/api/pois?q=lecture');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].name).toBe('NEH');
  });

  it('returns lat/lng separately for the client', async () => {
    const res = await request(makeApp()).get(`/api/pois/${NEH}`);
    expect(res.body.lat).toBeCloseTo(4.796, 5);
    expect(res.body.lng).toBeCloseTo(6.9795, 5);
  });

  it('paginates', async () => {
    const res = await request(makeApp()).get('/api/pois?limit=2&offset=0');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });

  it('rejects an unknown category', async () => {
    const res = await request(makeApp()).get('/api/pois?category=spaceport');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(makeApp()).get('/api/pois?limit=99999');
    expect(res.status).toBe(400);
  });

  it('rejects a non-uuid id', async () => {
    const res = await request(makeApp()).get('/api/pois/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  it('404s for a well-formed but unknown id', async () => {
    const res = await request(makeApp()).get('/api/pois/99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
  });

  it('returns an empty set for a miss', async () => {
    const res = await request(makeApp()).get('/api/pois?q=zzzzzz');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe('POST /api/corrections', () => {
  const valid = {
    poiId: NEH,
    kind: 'detail',
    detail: 'The hall is closed for renovation this semester',
    reporterDevice: 'test-device-1',
  };

  it('accepts a valid submission', async () => {
    const res = await request(makeApp()).post('/api/corrections').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.id).toBeTruthy();
  });

  it('does not mutate the POI on submission', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/corrections')
      .send({
        poiId: NEH,
        kind: 'renamed',
        detail: 'This building was renamed last year',
        proposedName: 'New Name Hall',
      });
    const poi = await request(app).get(`/api/pois/${NEH}`);
    expect(poi.body.name).toBe('NEH');
  });

  it('rejects an unknown poiId with 404, not 500', async () => {
    const res = await request(makeApp())
      .post('/api/corrections')
      .send({ ...valid, poiId: '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_poi');
  });

  it('rejects an incomplete submission with field errors', async () => {
    const res = await request(makeApp()).post('/api/corrections').send({ kind: 'moved' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_correction');
    expect(res.body.fields.detail).toBeTruthy();
  });

  it('rejects a malformed body', async () => {
    const res = await request(makeApp()).post('/api/corrections').send({ nonsense: true });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/corrections/mine', () => {
  it('lists submissions for a device', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/corrections')
      .send({ poiId: NEH, kind: 'detail', detail: 'Something is different here', reporterDevice: 'dev-1' });
    await request(app)
      .post('/api/corrections')
      .send({ poiId: NEH, kind: 'detail', detail: 'Another note from me', reporterDevice: 'dev-1' });

    const res = await request(app).get('/api/corrections/mine?device=dev-1');
    expect(res.body.items).toHaveLength(2);
  });

  it('does not leak other devices', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/corrections')
      .send({ poiId: NEH, kind: 'detail', detail: 'Note from the first device', reporterDevice: 'dev-1' });

    const res = await request(app).get('/api/corrections/mine?device=dev-2');
    expect(res.body.items).toHaveLength(0);
  });

  it('requires a device identifier', async () => {
    const res = await request(makeApp()).get('/api/corrections/mine');
    expect(res.status).toBe(400);
  });
});

describe('admin moderation', () => {
  async function submit(app) {
    const res = await request(app).post('/api/corrections').send({
      poiId: NEH,
      kind: 'renamed',
      detail: 'It was officially renamed last semester',
      proposedName: 'Faculty of Engineering Block B',
    });
    return res.body.id;
  }

  it('lists the pending queue by default', async () => {
    const app = makeApp();
    await submit(app);
    const res = await request(app).get('/api/admin/corrections');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe('pending');
  });

  it('applies an approved rename to the POI', async () => {
    const app = makeApp();
    const id = await submit(app);

    const review = await request(app)
      .patch(`/api/admin/corrections/${id}`)
      .send({ status: 'approved', reviewer: 'admin@rsu.edu.ng', note: 'confirmed on site' });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('approved');

    const poi = await request(app).get(`/api/pois/${NEH}`);
    expect(poi.body.name).toBe('Faculty of Engineering Block B');
    expect(poi.body.source).toBe('correction');
    expect(poi.body.verifiedAt).toBeTruthy();
  });

  it('leaves the POI untouched when rejected', async () => {
    const app = makeApp();
    const id = await submit(app);
    await request(app)
      .patch(`/api/admin/corrections/${id}`)
      .send({ status: 'rejected', reviewer: 'admin@rsu.edu.ng', note: 'wrong building' });

    const poi = await request(app).get(`/api/pois/${NEH}`);
    expect(poi.body.name).toBe('NEH');
  });

  it('applies a moved correction to the coordinates', async () => {
    const app = makeApp();
    const created = await request(app)
      .post('/api/corrections')
      .send({
        poiId: NEH,
        kind: 'moved',
        detail: 'The entrance now faces the car park',
        proposedLocation: { lat: 4.7999, lng: 6.9811 },
      });
    await request(app)
      .patch(`/api/admin/corrections/${created.body.id}`)
      .send({ status: 'approved', reviewer: 'admin@rsu.edu.ng' });

    const poi = await request(app).get(`/api/pois/${NEH}`);
    expect(poi.body.lat).toBeCloseTo(4.7999, 5);
    expect(poi.body.lng).toBeCloseTo(6.9811, 5);
  });

  it('requires a reviewer on the review call', async () => {
    const app = makeApp();
    const id = await submit(app);
    const res = await request(app)
      .patch(`/api/admin/corrections/${id}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_review');
  });

  it('404s when reviewing an unknown correction', async () => {
    const res = await request(makeApp())
      .patch('/api/admin/corrections/99999999-9999-4999-8999-999999999999')
      .send({ status: 'approved', reviewer: 'admin' });
    expect(res.status).toBe(404);
  });

  it('is closed to anonymous callers in production', async () => {
    // Previously this returned 501 in production, as a placeholder for auth
    // that had not been built. Now the gate is real, so the guarantee is
    // stronger and holds in every environment: no session, no admin.
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = createApp({ repo: createMemoryRepo(SEED) });
      const res = await request(app).get('/api/admin/corrections');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('not_authenticated');
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('is closed to a bogus session token in production', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = createApp({ repo: createMemoryRepo(SEED) });
      const res = await request(app)
        .get('/api/admin/corrections')
        .set('Authorization', 'Bearer not-a-real-token');
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('is closed to anonymous callers outside production too', async () => {
    // The old 501 gate only bit in production, which meant dev was open.
    const app = createApp({ repo: createMemoryRepo(SEED) });
    const res = await request(app).get('/api/admin/corrections');
    expect(res.status).toBe(401);
  });
});

describe('unknown routes', () => {
  it('returns JSON 404 rather than HTML', async () => {
    const res = await request(makeApp()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
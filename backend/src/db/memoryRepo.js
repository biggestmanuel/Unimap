import { randomUUID } from 'node:crypto';

/**
 * In-memory repository.
 *
 * Used by the test suite, and by `npm run dev` when no DATABASE_URL is
 * set, so the API is explorable before Postgres exists. Same interface
 * as the Postgres repository, so swapping is a one-line change in
 * server.js.
 */
export function createMemoryRepo(seed = []) {
  const pois = new Map();
  const corrections = new Map();

  for (const p of seed) {
    const id = p.id ?? randomUUID();
    pois.set(id, {
      id,
      name: p.name,
      category: p.category ?? 'other',
      description: p.description ?? null,
      accessibility: p.accessibility ?? [],
      safety: p.safety ?? false,
      lat: p.lat,
      lng: p.lng,
      source: p.source ?? 'seed',
      verifiedAt: p.verifiedAt ?? null,
    });
  }

  return {
    async listPois({ q, category, limit, offset }) {
      let items = [...pois.values()];

      if (category) items = items.filter((p) => p.category === category);
      if (q) {
        const needle = q.toLowerCase();
        items = items.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            (p.description ?? '').toLowerCase().includes(needle),
        );
      }

      const total = items.length;
      items = items.slice(offset, offset + limit);
      return { items, total };
    },

    async getPoi(id) {
      return pois.get(id) ?? null;
    },

    async createCorrection(payload) {
      const id = randomUUID();
      const record = {
        id,
        poiId: payload.poiId ?? null,
        proposedName: payload.proposedName ?? null,
        proposedCategory: payload.proposedCategory ?? null,
        proposedLat: payload.proposedLocation?.lat ?? null,
        proposedLng: payload.proposedLocation?.lng ?? null,
        kind: payload.kind,
        detail: payload.detail,
        reporterEmail: payload.reporterEmail ?? null,
        reporterDevice: payload.reporterDevice ?? null,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: new Date().toISOString(),
      };
      corrections.set(id, record);
      return record;
    },

    async listCorrections({ status, reporterDevice, limit, offset }) {
      let items = [...corrections.values()];
      if (status) items = items.filter((c) => c.status === status);
      if (reporterDevice) items = items.filter((c) => c.reporterDevice === reporterDevice);
      const total = items.length;
      return { items: items.slice(offset, offset + limit), total };
    },

    async reviewCorrection(id, { status, note, reviewer }) {
      const record = corrections.get(id);
      if (!record) return null;

      record.status = status;
      record.reviewNote = note ?? null;
      record.reviewedBy = reviewer;
      record.reviewedAt = new Date().toISOString();

      // Approval is what actually mutates campus data.
      if (status === 'approved' && record.poiId) {
        const poi = pois.get(record.poiId);
        if (poi) {
          if (record.proposedName) poi.name = record.proposedName;
          if (record.proposedCategory) poi.category = record.proposedCategory;
          if (record.proposedLat != null && record.proposedLng != null) {
            poi.lat = record.proposedLat;
            poi.lng = record.proposedLng;
          }
          poi.source = 'correction';
          poi.verifiedAt = new Date().toISOString();
        }
      }

      return record;
    },
  };
}
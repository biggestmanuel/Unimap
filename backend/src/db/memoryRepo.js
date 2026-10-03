import { randomUUID } from 'node:crypto';
import { verifyPassword } from '../lib/auth.js';

/**
 * In-memory repository.
 *
 * Used by the test suite, and by `npm run dev` when no DATABASE_URL is
 * set, so the API is explorable before Postgres exists. Same interface
 * as the Postgres repository, so swapping is a one-line change in
 * server.js.
 */
export function createMemoryRepo(seed = [], { users = [] } = {}) {
  const pois = new Map();
  const corrections = new Map();
  const userRows = new Map();
  const sessions = new Map();
  const audit = [];
  const traces = new Map();

  for (const u of users) {
    userRows.set(u.id ?? randomUUID(), {
      id: u.id ?? randomUUID(),
      email: (u.email ?? '').toLowerCase(),
      displayName: u.displayName ?? null,
      role: u.role ?? 'student',
      passwordHash: u.passwordHash,
    });
  }

  // Seeded rows above may disagree on id if one was omitted; rebuild cleanly.
  if (users.length > 0) {
    userRows.clear();
    for (const u of users) {
      const id = u.id ?? randomUUID();
      userRows.set(id, {
        id,
        email: (u.email ?? '').toLowerCase(),
        displayName: u.displayName ?? null,
        role: u.role ?? 'student',
        passwordHash: u.passwordHash,
      });
    }
  }

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
    async listPois({ q, category, limit = 200, offset = 0 }) {
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

    async listCorrections({
      status,
      reporterDevice,
      limit = 200,
      offset = 0,
    }) {
      let items = [...corrections.values()];
      if (status) items = items.filter((c) => c.status === status);
      if (reporterDevice) items = items.filter((c) => c.reporterDevice === reporterDevice);
      const total = items.length;
      // Defaults matter here: `offset + limit` with either undefined is NaN,
      // and slice(_, NaN) silently returns an empty page.
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

    // ── auth ─────────────────────────────────────────────────────────
    async findUserByEmail(email) {
      const needle = String(email).toLowerCase();
      for (const u of userRows.values()) {
        if (u.email === needle) return u;
      }
      return null;
    },

    async getUser(id) {
      return userRows.get(id) ?? null;
    },

    async createUser({ email, displayName, role, passwordHash }) {
      const id = randomUUID();
      const record = {
        id,
        email: String(email).toLowerCase(),
        displayName: displayName ?? null,
        role: role ?? 'student',
        passwordHash,
      };
      userRows.set(id, record);
      return record;
    },

    async listUsers() {
      return [...userRows.values()];
    },

    async verifyUserPassword(id, password) {
      const user = userRows.get(id);
      if (!user) return false;
      return verifyPassword(password, user.passwordHash);
    },

    async createSession({ userId, tokenHash, expiresAt, userAgent }) {
      const record = {
        id: randomUUID(),
        userId,
        tokenHash,
        expiresAt: new Date(expiresAt).toISOString(),
        userAgent: userAgent ?? null,
      };
      sessions.set(tokenHash, record);
      return record;
    },

    async findSessionByTokenHash(tokenHash) {
      return sessions.get(tokenHash) ?? null;
    },

    async deleteSessionByTokenHash(tokenHash) {
      sessions.delete(tokenHash);
    },

    async purgeExpiredSessions() {
      const now = Date.now();
      let n = 0;
      for (const [k, s] of sessions) {
        if (new Date(s.expiresAt).getTime() <= now) {
          sessions.delete(k);
          n += 1;
        }
      }
      return n;
    },

    async listAuditLog({ limit = 100 } = {}) {
      return audit.slice(0, limit);
    },

    // ── walk traces ───────────────────────────────────────────────────
    async createTrace({ coords, pointCount, distanceMeters, maxOffGraphMeters, note, reporterDevice }) {
      const id = randomUUID();
      const record = {
        id,
        coords,
        pointCount,
        distanceMeters,
        maxOffGraphMeters: maxOffGraphMeters ?? null,
        note: note ?? null,
        reporterDevice: reporterDevice ?? null,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: new Date().toISOString(),
      };
      traces.set(id, record);
      return record;
    },

    async listTraces({ status, limit = 50, offset = 0 } = {}) {
      let items = [...traces.values()];
      if (status) items = items.filter((t) => t.status === status);
      // Furthest off-graph first: those are the ones worth a human's time.
      items.sort(
        (a, b) => (b.maxOffGraphMeters ?? -1) - (a.maxOffGraphMeters ?? -1),
      );
      const total = items.length;
      return { items: items.slice(offset, offset + limit), total };
    },

    async reviewTrace(id, { status, note, reviewer }) {
      const record = traces.get(id);
      if (!record) return null;
      record.status = status;
      record.reviewNote = note ?? null;
      record.reviewedBy = reviewer;
      record.reviewedAt = new Date().toISOString();
      return record;
    },
  };
}
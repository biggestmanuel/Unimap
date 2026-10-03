import { randomUUID } from 'node:crypto';
import { verifyPassword } from '../lib/auth.js';
import { simplifyLine, dedupeConsecutive } from '../graph/simplify.js';
import { lineLengthMeters } from '../graph/geo.js';
import { snapEndpoints } from '../graph/snap.js';

const TRACE_SIMPLIFY_METERS = 3;
const TRACE_DEDUPE_METERS = 1;
const MIN_EDGE_METERS = 5;

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
  const traceEdges = [];

  for (const u of users) {
    const id = u.id ?? randomUUID();
    userRows.set(id, {
      id,
      email: (u.email ?? '').toLowerCase(),
      displayName: u.displayName ?? null,
      role: u.role ?? 'student',
      passwordHash: u.passwordHash,
      // Seeded disabled when a test wants to start from a stood-down
      // account. Must be present rather than undefined, because the login
      // route and the admin gate both test it for `!= null`.
      disabledAt: u.disabledAt ?? null,
    });
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

    async setUserDisabled(id, disabled) {
      const user = userRows.get(id);
      if (!user) return null;
      user.disabledAt = disabled ? new Date().toISOString() : null;
      return user;
    },

    async deleteSessionsForUser(userId) {
      let n = 0;
      for (const [tokenHash, session] of sessions) {
        if (session.userId !== userId) continue;
        sessions.delete(tokenHash);
        n += 1;
      }
      return n;
    },

    async deleteUser(id) {
      const user = userRows.get(id);
      if (!user) return false;
      userRows.delete(id);
      // Mirrors the Postgres ON DELETE CASCADE, so the in-memory double behaves
      // like the real thing rather than leaving sessions resolvable to nobody.
      await this.deleteSessionsForUser(id);
      return true;
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

    async appendAudit({ actor, action, entityType, entityId, afterData = null }) {
      const record = {
        id: audit.length + 1,
        actor: actor ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId ?? null,
        before_data: null,
        after_data: afterData,
        created_at: new Date().toISOString(),
      };
      audit.push(record);
      return record;
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

    /**
     * Merge into the in-memory graph.
     *
     * The memory repo has no graph_edges table, so the edge is appended to the
     * rows array the graph repository was built from and the cache is dropped.
     * Behaviourally equivalent to the Postgres path for the purposes of the
     * route tests.
     */
    /** Edges created by mergeTraceIntoGraph, for tests to assert against. */
    listTraceEdges() {
      return [...traceEdges];
    },

    async mergeTraceIntoGraph(id, { reviewer, note, graph, snapTolerance } = {}) {
      const record = traces.get(id);
      if (!record) return null;
      if (record.mergedEdgeId != null || record.status === 'merged') {
        const err = new Error('already merged');
        err.code = 'already_merged';
        throw err;
      }

      // Endpoints onto the network, middle left as walked.
      const { coords, snapped } = snapEndpoints(record.coords, graph, snapTolerance);

      const cleaned = dedupeConsecutive(coords, TRACE_DEDUPE_METERS);
      const simplified = simplifyLine(cleaned, TRACE_SIMPLIFY_METERS);
      if (simplified.length < 2 || lineLengthMeters(simplified) < MIN_EDGE_METERS) {
        const err = new Error('trace is too short to become an edge');
        err.code = 'too_short';
        throw err;
      }

      const edgeId = randomUUID();
      traceEdges.push({
        id: edgeId,
        edgeClass: 'footpath',
        coords: simplified,
        source: 'walk-trace',
      });
      record.coords = simplified;
      record.mergedEdgeId = edgeId;
      record.status = 'merged';
      record.reviewedBy = reviewer ?? null;
      record.reviewedAt = new Date().toISOString();
      record.reviewNote = note ?? record.reviewNote;

      return {
        edge: {
          id: edgeId,
          edgeClass: 'footpath',
          name: record.note ? `Walk trace ${String(record.id).slice(0, 8)}` : null,
          source: 'walk-trace',
          vertices: simplified.length,
          coords: simplified,
          // How far each end had to move to meet the network, so a suspicious
          // merge is visible rather than silent.
          snapped,
        },
        trace: { ...record },
      };
    },
  };
}
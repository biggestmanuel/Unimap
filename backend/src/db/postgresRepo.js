import { getPool, rowToPoi, rowToSession, rowToUser } from './pool.js';
import { verifyPassword } from '../lib/auth.js';
import { simplifyLine, dedupeConsecutive } from '../graph/simplify.js';
import { lineLengthMeters } from '../graph/geo.js';

/**
 * How hard to clean a trace before it becomes geometry.
 *
 * Deliberately gentle. A person walking with a phone is a far better witness
 * to where a path goes than anything derived from aerial imagery, so the aim
 * is to remove jitter without smoothing away a real bend -- and if an admin
 * disagrees with the shape, the trace row is still intact and they can reject
 * it instead.
 */
const TRACE_SIMPLIFY_METERS = 3;
const TRACE_DEDUPE_METERS = 1;

/**
 * Shortest run worth adding to the graph.
 *
 * Checked on length rather than vertex count, because a stationary phone can
 * produce two distinct coordinates a metre apart: that survives the 0.5 m
 * ingest filter and is technically a LineString, but a 1 m footpath is noise
 * that costs a node in every routing search and helps nobody.
 */
const MIN_EDGE_METERS = 5;

/**
 * Postgres repository.
 *
 * Spatial work is pushed into PostGIS rather than done in JS: full-text
 * search, nearest-neighbour and boundary tests all become index-backed
 * SQL instead of table scans over 79 (soon thousands of) rows.
 */
export function createPostgresRepo() {
  return {
    async listPois({ q, category, limit, offset }) {
      const pool = getPool();
      const conditions = [];
      const params = [];

      if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }

      if (q) {
        params.push(q);
        conditions.push(
          `to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))
           @@ plainto_tsquery('simple', $${params.length})`,
        );
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const count = await pool.query(
        `SELECT count(*)::int AS total FROM pois ${where}`,
        params,
      );

      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT id, name, category, description, accessibility, safety,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lng,
                source, verified_at
           FROM pois
           ${where}
          ORDER BY name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return { items: rows.rows.map(rowToPoi), total: count.rows[0].total };
    },

    async getPoi(id) {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, name, category, description, accessibility, safety,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lng,
                source, verified_at
           FROM pois WHERE id = $1`,
        [id],
      );
      return rows[0] ? rowToPoi(rows[0]) : null;
    },

    async createCorrection(payload) {
      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO corrections
           (poi_id, kind, detail, proposed_name, proposed_category,
            proposed_location, reporter_email, reporter_device)
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $6::float IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography END,
                 $8, $9)
         RETURNING id, poi_id, kind, detail, status, created_at`,
        [
          payload.poiId ?? null,
          payload.kind,
          payload.detail,
          payload.proposedName ?? null,
          payload.proposedCategory ?? null,
          payload.proposedLocation?.lng ?? null,
          payload.proposedLocation?.lat ?? null,
          payload.reporterEmail ?? null,
          payload.reporterDevice ?? null,
        ],
      );
      return rows[0];
    },

    async listCorrections({ status, reporterDevice, limit, offset }) {
      const pool = getPool();
      const conditions = [];
      const params = [];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (reporterDevice) {
        params.push(reporterDevice);
        conditions.push(`reporter_device = $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const count = await pool.query(
        `SELECT count(*)::int AS total FROM corrections ${where}`,
        params,
      );

      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT id, poi_id, kind, detail, proposed_name, proposed_category,
                CASE WHEN proposed_location IS NULL THEN NULL
                     ELSE json_build_object(
                       'lat', ST_Y(proposed_location::geometry),
                       'lng', ST_X(proposed_location::geometry)) END AS proposed_location,
                status, reviewed_by, reviewed_at, review_note, created_at
           FROM corrections ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return { items: rows.rows, total: count.rows[0].total };
    },

    /**
     * Approve or reject.
     *
     * Runs in one transaction: the moderation decision, the audit row and
     * the POI mutation either all land or none do. Without this a crash
     * between "approved" and "POI updated" would leave campus data
     * permanently out of sync with the reviewer's decision.
     */
    async reviewCorrection(id, { status, note, reviewer }) {
      const pool = getPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const before = await client.query('SELECT * FROM corrections WHERE id = $1 FOR UPDATE', [id]);
        if (before.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }

        await client.query(
          `UPDATE corrections
              SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now()
            WHERE id = $1`,
          [id, status, note ?? null, reviewer],
        );

        if (status === 'approved' && before.rows[0].poi_id) {
          const poiBefore = await client.query('SELECT * FROM pois WHERE id = $1', [
            before.rows[0].poi_id,
          ]);
          if (poiBefore.rowCount > 0) {
            await client.query(
              `UPDATE pois
                  SET name = COALESCE($2, name),
                      category = COALESCE($3, category),
                      location = COALESCE($4, location),
                      source = 'correction',
                      verified_at = now()
                WHERE id = $1`,
              [
                before.rows[0].poi_id,
                before.rows[0].proposed_name,
                before.rows[0].proposed_category,
                before.rows[0].proposed_location,
              ],
            );

            await client.query(
              `INSERT INTO audit_log (actor, action, entity_type, entity_id, before_data, after_data)
               VALUES ($1, 'correction.approved', 'poi', $2, $3, $4)`,
              [reviewer, before.rows[0].poi_id, poiBefore.rows[0], before.rows[0]],
            );
          }
        }

        await client.query(
          `INSERT INTO audit_log (actor, action, entity_type, entity_id, after_data)
           VALUES ($1, $2, 'correction', $3, $4)`,
          [reviewer, `correction.${status}`, id, { status, note: note ?? null }],
        );

        const after = await client.query('SELECT * FROM corrections WHERE id = $1', [id]);
        await client.query('COMMIT');
        return after.rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // ── auth ──────────────────────────────────────────────────────────
    async findUserByEmail(email) {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT id, email, display_name, role, password_hash FROM users WHERE lower(email) = lower($1)',
        [email],
      );
      return rows[0] ?? null;
    },

    async getUser(id) {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT id, email, display_name, role, disabled_at FROM users WHERE id = $1',
        [id],
      );
      return rows[0] ? rowToUser(rows[0]) : null;
    },

    async setUserDisabled(id, disabled) {
      const pool = getPool();
      const { rows } = await pool.query(
        `UPDATE users
            SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END
          WHERE id = $1
        RETURNING id, email, display_name, role, disabled_at`,
        [id, Boolean(disabled)],
      );
      return rows[0] ? rowToUser(rows[0]) : null;
    },

    async deleteSessionsForUser(userId) {
      const pool = getPool();
      const { rowCount } = await pool.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [userId],
      );
      return rowCount ?? 0;
    },

    async deleteUser(id) {
      const pool = getPool();
      // sessions.user_id is ON DELETE CASCADE, so live tokens die with the
      // account rather than lingering as unresolvable rows.
      const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },

    async createUser({ email, displayName, role, passwordHash }) {
      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO users (email, display_name, role, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, role`,
        [String(email).toLowerCase(), displayName ?? null, role ?? 'student', passwordHash],
      );
      return rows[0];
    },

    async listUsers() {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.disabled_at,
                count(s.id)::int AS active_sessions
           FROM users u
           LEFT JOIN sessions s
             ON s.user_id = u.id AND s.expires_at > now()
          GROUP BY u.id
          ORDER BY u.created_at DESC`,
      );
      return rows.map(rowToUser);
    },

    async verifyUserPassword(id, password) {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [id],
      );
      if (!rows[0]) return false;
      return verifyPassword(password, rows[0].password_hash);
    },

    async createSession({ userId, tokenHash, expiresAt, userAgent }) {
      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, tokenHash, expiresAt, userAgent ?? null],
      );
      return rowToSession(rows[0]);
    },

    async findSessionByTokenHash(tokenHash) {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT * FROM sessions WHERE token_hash = $1',
        [tokenHash],
      );
      return rowToSession(rows[0]);
    },

    async deleteSessionByTokenHash(tokenHash) {
      const pool = getPool();
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    async purgeExpiredSessions() {
      const pool = getPool();
      const { rowCount } = await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
      return rowCount ?? 0;
    },

    async listAuditLog({ limit = 100 } = {}) {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1',
        [limit],
      );
      return rows;
    },

    async appendAudit({ actor, action, entityType, entityId, afterData = null }) {
      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO audit_log (actor, action, entity_type, entity_id, after_data)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [actor ?? null, action, entityType, entityId ?? null,
          afterData == null ? null : JSON.stringify(afterData)],
      );
      return rows[0];
    },

    // ── walk traces ───────────────────────────────────────────────────
    async createTrace({ coords, pointCount, distanceMeters, maxOffGraphMeters, note, reporterDevice }) {
      const pool = getPool();
      const geojson = JSON.stringify({
        type: 'LineString',
        coordinates: coords.map((p) => [p.lng, p.lat]),
      });
      const { rows } = await pool.query(
        `INSERT INTO walk_traces
           (geom, point_count, distance_m, max_off_graph_m, note, reporter_device)
         VALUES (ST_GeomFromGeoJSON($1), $2, $3, $4, $5, $6)
         RETURNING id, point_count, distance_m, max_off_graph_m, note, status, created_at`,
        [geojson, pointCount, distanceMeters, maxOffGraphMeters, note ?? null, reporterDevice ?? null],
      );
      const r = rows[0];
      return {
        id: r.id,
        pointCount: r.point_count,
        distanceMeters: Number(r.distance_m),
        maxOffGraphMeters: r.max_off_graph_m == null ? null : Number(r.max_off_graph_m),
        note: r.note,
        status: r.status,
        createdAt: r.created_at,
      };
    },

    async listTraces({ status, limit = 50 } = {}) {
      const pool = getPool();
      const params = [];
      const where = status ? `WHERE status = $${params.push(status)}` : '';
      // Furthest off-graph first: those are the ones worth a human's time.
      params.push(limit);
      const { rows } = await pool.query(
        `SELECT id, point_count, distance_m, max_off_graph_m, note, status,
                reporter_device, created_at, reviewed_by, review_note
           FROM walk_traces ${where}
          ORDER BY max_off_graph_m DESC NULLS LAST, created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return {
        total: rows.length,
        items: rows.map((r) => ({
          id: r.id,
          pointCount: r.point_count,
          distanceMeters: Number(r.distance_m),
          maxOffGraphMeters: r.max_off_graph_m == null ? null : Number(r.max_off_graph_m),
          note: r.note,
          status: r.status,
          createdAt: r.created_at,
          reviewedBy: r.reviewed_by,
          reviewNote: r.review_note,
        })),
      };
    },

    async reviewTrace(id, { status, note, reviewer }) {
      const pool = getPool();
      const { rows } = await pool.query(
        `UPDATE walk_traces
            SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = now()
          WHERE id = $4
        RETURNING id, point_count, distance_m, max_off_graph_m, note, status, created_at`,
        [status, note ?? null, reviewer, id],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id,
        pointCount: r.point_count,
        distanceMeters: Number(r.distance_m),
        maxOffGraphMeters: r.max_off_graph_m == null ? null : Number(r.max_off_graph_m),
        note: r.note,
        status: r.status,
        createdAt: r.created_at,
      };
    },

    /**
     * Turn an approved trace into a real footpath edge.
     *
     * Runs in one transaction: the edge insert and the status change either
     * both land or neither does, so a failure cannot leave a trace marked
     * merged with no geometry behind it -- which would be silently
     * unrecoverable through the API.
     */
    async mergeTraceIntoGraph(id, { reviewer, note } = {}) {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // FOR UPDATE so two admins merging the same trace at once cannot both
        // read status='approved' and both insert.
        const { rows } = await client.query(
          `SELECT id, geom, point_count, distance_m, max_off_graph_m, note,
                  status, created_at
             FROM walk_traces
            WHERE id = $1
              FOR UPDATE`,
          [id],
        );
        if (rows.length === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        const t = rows[0];

        if (t.merged_edge_id != null || t.status === 'merged') {
          await client.query('ROLLBACK');
          const err = new Error('already merged');
          err.code = 'already_merged';
          throw err;
        }

        // Simplify before storing, for the reason documented in
        // graph/simplify.js: buildGraph splits every edge at every vertex, so
        // raw GPS jitter would add thousands of routing nodes per trace.
        const geojson = await client.query(
          'SELECT ST_AsGeoJSON(geom)::json AS geo FROM walk_traces WHERE id = $1',
          [id],
        );
        const geometry = geojson.rows[0]?.geo;
        if (!geometry) {
          await client.query('ROLLBACK');
          const err = new Error('trace has no geometry');
          err.code = 'no_geometry';
          throw err;
        }

        const coords = geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        const cleaned = dedupeConsecutive(coords, TRACE_DEDUPE_METERS);
        const simplified = simplifyLine(cleaned, TRACE_SIMPLIFY_METERS);

        if (simplified.length < 2 || lineLengthMeters(simplified) < MIN_EDGE_METERS) {
          await client.query('ROLLBACK');
          const err = new Error('trace is too short to become an edge');
          err.code = 'too_short';
          throw err;
        }

        const lineGeoJson = JSON.stringify({
          type: 'LineString',
          coordinates: simplified.map((p) => [p.lng, p.lat]),
        });

        // footpath, not corridor: a hand-recorded path is a shortcut, and
        // claiming it is a backbone road would over-trust data quality. The
        // router only uses a footpath when it can get you back onto a
        // corridor, so a disconnected one is inert rather than misleading.
        const edge = await client.query(
          `INSERT INTO graph_edges (geom, edge_class, name, source, surface)
           VALUES (ST_GeomFromGeoJSON($1), 'footpath', $2, 'walk-trace', NULL)
           RETURNING id, edge_class, name, source`,
          [lineGeoJson, t.note ? `Walk trace ${String(t.id).slice(0, 8)}` : null],
        );

        const updated = await client.query(
          `UPDATE walk_traces
              SET status = 'merged',
                  reviewed_by = $2,
                  reviewed_at = now(),
                  review_note = COALESCE($3, review_note),
                  merged_edge_id = $4
            WHERE id = $1
          RETURNING id, point_count, distance_m, max_off_graph_m, note, status, created_at`,
          [id, reviewer ?? null, note ?? null, edge.rows[0].id],
        );

        await client.query('COMMIT');

        const r = updated.rows[0];
        return {
          edge: {
            id: edge.rows[0].id,
            edgeClass: edge.rows[0].edge_class,
            name: edge.rows[0].name,
            source: edge.rows[0].source,
            vertices: simplified.length,
            // Handed to graphRepo.edgeAdded so the in-memory graph
            // implementation, which has no database to re-read, can append the
            // same geometry. The Postgres implementation ignores it.
            coords: simplified,
          },
          trace: {
            id: r.id,
            pointCount: r.point_count,
            distanceMeters: Number(r.distance_m),
            maxOffGraphMeters: r.max_off_graph_m == null ? null : Number(r.max_off_graph_m),
            note: r.note,
            status: r.status,
            createdAt: r.created_at,
          },
        };
      } catch (err) {
        // Only roll back if we actually opened a transaction; a failed BEGIN
        // or an already-issued ROLLBACK would otherwise raise a second error
        // and hide the real one.
        try {
          await client.query('ROLLBACK');
        } catch { /* already rolled back */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
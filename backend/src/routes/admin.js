import { Router } from 'express';
import { createUserSchema, updateUserSchema, formatIssues } from '../lib/validation.js';
import { hashPassword, checkPasswordStrength, publicUser } from '../lib/auth.js';

/**
 * Admin-only surface.
 *
 * Every route here sits behind `requireAdmin`, which is real authentication
 * with a real role check -- this replaces the "501 in production" placeholder
 * that used to guard the correction review endpoints.
 *
 * Kept in its own router so the admin panel can be a separate bundle and the
 * student PWA never downloads any of it.
 */
export default function createAdminRoutes({ repo, graphRepo, requireAdmin }) {
  const router = Router();
  // The gate authenticates and populates req.user for every route below.
  router.use('/admin', requireAdmin);

  router.get('/admin/me', (req, res) => {
    // The gate has already populated req.user.
    res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role } });
  });

  router.get('/admin/summary', async (req, res, next) => {
    try {
      const [pending, recent, users, stats] = await Promise.all([
        repo.listCorrections({ status: 'pending', limit: 1, offset: 0 }),
        // Only five are shown, so ask for five rather than a hundred.
        repo.listCorrections({ status: 'pending', limit: 5, offset: 0 }),
        repo.listUsers(),
        graphRepo.getStats(),
      ]);

      res.json({
        pendingCorrections: pending.total,
        users: users.length,
        admins: users.filter((u) => u.role === 'admin').length,
        graph: {
          totalWays: stats.totalWays,
          connectedGroups: stats.groups,
          islandCount: stats.islands.length,
          deadEndCount: stats.deadEndCount,
          totalMeters: Math.round(stats.totalMeters ?? 0),
        },
        recent: recent.items,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/users', async (req, res, next) => {
    try {
      // publicUser, not the raw row: these records carry password hashes.
      res.json({ items: (await repo.listUsers()).map(publicUser) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/users', async (req, res, next) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_user', fields: formatIssues(parsed.error) });
    }

    const { password, ...rest } = parsed.data;

    // Belt and braces: the Zod minimum and the policy check must agree.
    const issues = checkPasswordStrength(password);
    if (issues.length > 0) {
      return res.status(400).json({ error: 'weak_password', fields: { password: issues[0] } });
    }

    try {
      const existing = await repo.findUserByEmail(rest.email);
      if (existing) {
        return res.status(409).json({ error: 'email_taken' });
      }

      const created = await repo.createUser({
        ...rest,
        passwordHash: await hashPassword(password),
      });

      // Creating an admin is precisely the action an audit trail exists for:
      // without this, a rogue or careless admin could mint further admins
      // and nothing would record who did it.
      await repo.appendAudit?.({
        actor: req.user.email,
        action: 'user.created',
        entityType: 'user',
        entityId: created.id,
        afterData: { email: created.email, role: created.role },
      });

      res.status(201).json({ user: publicUser(created) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Remove a footpath that came from a walk trace.
   *
   * Merging a trace writes real geometry into `graph_edges`, so an admin who
   * merges something wrong needs a way to take it back out. Without this the
   * only remedy is direct SQL, which is exactly the situation the rest of the
   * console exists to avoid.
   *
   * Scoped to `source = 'walk-trace'` on purpose: OSM geometry is the campus's
   * shared source of truth and must not be deletable from here. Deleting one
   * resets its trace to `pending` too, so a corrected recording can be merged
   * again once the edge is gone.
   */
  router.delete('/admin/graph/edges/:id', async (req, res, next) => {
    try {
      const edge = await repo.getGraphEdge?.(req.params.id);
      if (!edge) return res.status(404).json({ error: 'not_found' });

      if (edge.source !== 'walk-trace') {
        return res.status(409).json({ error: 'not_a_trace_edge' });
      }

      // The repository reopens the owning trace in the same transaction: an edge
      // removed while its trace still read 'merged' would be unrecoverable
      // through the API.
      const result = await repo.deleteTraceEdge(req.params.id);
      if (!result?.deleted) return res.status(404).json({ error: 'not_found' });

      await repo.appendAudit?.({
        actor: req.user.email,
        action: 'graph.trace_edge_deleted',
        entityType: 'graph_edge',
        entityId: req.params.id,
        beforeData: { edgeClass: edge.edgeClass, source: edge.source, name: edge.name },
        afterData: { traceReopened: result.traceReopened },
      });

      // Both, and in this order: the in-memory graph has to actually drop the row,
      // while Postgres only needs the cache dropped. Calling only invalidate()
      // would leave the in-memory version routing people down a removed path.
      await graphRepo.edgeRemoved?.(req.params.id);
      graphRepo.invalidate?.();

      res.json({
        ok: true,
        edgeId: req.params.id,
        traceReopened: result.traceReopened,
        stats: await graphRepo.getStats(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── standing an account down ─────────────────────────────────────────
  // Deliberately separate from DELETE. Disabling keeps the row, its audit
  // trail and its review history; it only stops the account authenticating.
  // Most of the time that is what you want, because it is reversible and it
  // leaves the record intact.
  router.patch('/admin/users/:id', async (req, res, next) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_user', fields: formatIssues(parsed.error) });
    }

    try {
      const target = await repo.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'not_found' });

      // Standing yourself down is almost always a mistake, and it locks the
      // console on the next request with no way back through the UI. Refuse it
      // here rather than letting someone discover that the hard way.
      if (parsed.data.disabled === true && target.id === req.user.id) {
        return res.status(409).json({ error: 'cannot_disable_self' });
      }

      const updated = await repo.setUserDisabled(target.id, parsed.data.disabled);

      // A disabled account must not keep a working session, so disabling
      // revokes in the same action rather than leaving the token live for its
      // remaining lifetime.
      const revoked = parsed.data.disabled === true
        ? await repo.deleteSessionsForUser(target.id)
        : 0;

      await repo.appendAudit?.({
        actor: req.user.email,
        action: parsed.data.disabled === true ? 'user.disabled' : 'user.enabled',
        entityType: 'user',
        entityId: target.id,
        beforeData: { disabled: target.disabledAt != null },
        afterData: { disabled: parsed.data.disabled === true },
      });

      res.json({ user: publicUser(updated), revokedSessions: revoked });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/users/:id/revoke-sessions', async (req, res, next) => {
    try {
      const target = await repo.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'not_found' });

      // The reason this endpoint exists: changing a password does not touch
      // sessions, because a session is keyed by its own token hash rather than
      // by the password. Without this, a password reset alone cannot kick out
      // whoever prompted it.
      const revoked = await repo.deleteSessionsForUser(target.id);

      await repo.appendAudit?.({
        actor: req.user.email,
        action: 'user.sessions_revoked',
        entityType: 'user',
        entityId: target.id,
        afterData: { revoked },
      });

      res.json({ revokedSessions: revoked });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/admin/users/:id', async (req, res, next) => {
    try {
      const target = await repo.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'not_found' });

      if (target.id === req.user.id) {
        return res.status(409).json({ error: 'cannot_delete_self' });
      }

      // Refuse to remove the last route into the admin panel. An empty admin
      // set means the only way back is direct SQL against the database, which
      // is exactly the failure this whole feature exists to prevent.
      const admins = (await repo.listUsers()).filter(
        (u) => u.role === 'admin' && u.disabledAt == null && u.id !== target.id,
      );
      if (target.role === 'admin' && admins.length === 0) {
        return res.status(409).json({ error: 'last_admin' });
      }

      await repo.deleteUser(target.id);

      await repo.appendAudit?.({
        actor: req.user.email,
        action: 'user.deleted',
        entityType: 'user',
        entityId: target.id,
        beforeData: { email: target.email, role: target.role },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/audit', async (req, res, next) => {
    try {
      res.json({ items: await repo.listAuditLog({ limit: 100 }) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
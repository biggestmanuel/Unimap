import { Router } from 'express';
import { createUserSchema, formatIssues } from '../lib/validation.js';
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
      const [pending, all, users] = await Promise.all([
        repo.listCorrections({ status: 'pending', limit: 1, offset: 0 }),
        repo.listCorrections({ status: 'pending', limit: 100, offset: 0 }),
        repo.listUsers(),
      ]);
      const stats = await graphRepo.getStats();

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
        recent: all.items.slice(0, 5),
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
      res.status(201).json({ user: publicUser(created) });
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
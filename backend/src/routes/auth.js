import { Router } from 'express';
import { loginSchema, formatIssues } from '../lib/validation.js';
import { newSessionToken, hashToken, sessionExpiry, publicUser } from '../lib/auth.js';

/**
 * Set the session cookie.
 *
 * Written by hand rather than via res.cookie() so the project does not need
 * cookie-parser for a single header.
 */
function setSessionCookie(res, token) {
  const attrs = [
    `unimap_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'unimap_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/**
 * Login / logout / whoami.
 *
 * Sessions are server-side and revocable, and the token lives in an
 * HttpOnly cookie rather than localStorage — an XSS in the PWA cannot then
 * read it. `sameSite: 'lax'` is enough because nothing here is cross-site.
 */
export default function createAuthRoutes({ repo }) {
  const router = Router();

  router.post('/auth/login', async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_credentials_format',
        fields: formatIssues(parsed.error),
      });
    }

    try {
      const { email, password } = parsed.data;
      const user = await repo.findUserByEmail(email);

      // Always run a verification, even when the user does not exist, so the
      // response time does not reveal which addresses are registered.
      const ok = user
        ? await repo.verifyUserPassword(user.id, password)
        : false;

      if (!user || !ok) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      // Refused with the same error as a wrong password: a disabled account
      // that says "your account is disabled" confirms the address is
      // registered to anyone who guesses it.
      if (user.disabledAt != null) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      const token = newSessionToken();
      await repo.createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: sessionExpiry(),
        userAgent: req.get('user-agent') ?? null,
      });

      setSessionCookie(res, token);

      res.json({
        user: publicUser(user),
        // Also returned in the body so a non-browser client (the admin
        // script, curl) can use it. The cookie is the browser path.
        token,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/logout', async (req, res, next) => {
    try {
      const token = readToken(req);
      if (token) await repo.deleteSessionByTokenHash(hashToken(token));
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/me', async (req, res, next) => {
    try {
      const user = await resolveUser(req, repo);
      if (!user) return res.status(401).json({ error: 'not_authenticated' });
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Token from the cookie, or from an Authorization header for CLI use. */
export function readToken(req) {
  const header = req.get('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookie = req.headers?.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'unimap_session') return decodeURIComponent(v.join('='));
  }
  return null;
}

/** The signed-in user, or null. Never throws on a bad token. */
export async function resolveUser(req, repo) {
  const token = readToken(req);
  if (!token) return null;
  const session = await repo.findSessionByTokenHash(hashToken(token));
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await repo.deleteSessionByTokenHash(hashToken(token));
    return null;
  }

  const user = await repo.getUser(session.userId);
  if (!user) return null;

  // A session outlives an account being deleted or disabled, so drop the
  // token here rather than letting a stale one linger until it expires.
  if (user.disabledAt != null) {
    await repo.deleteSessionByTokenHash(hashToken(token));
    return null;
  }

  return user;
}

/**
 * Build the admin gate.
 *
 * Returns a middleware so the same policy applies to every protected route,
 * and so `createApp` can be handed a stub in tests. This is real
 * authentication with a real role check — it replaces the "501 in production"
 * placeholder that used to guard the correction review endpoints.
 */
export function makeRequireAdmin({ repo }) {
  return async (req, res, next) => {
    try {
      const user = await resolveUser(req, repo);
      if (!user) return res.status(401).json({ error: 'not_authenticated' });

      // Checked here rather than only at login, so an account disabled while
      // its owner is already signed in loses access on the next request
      // instead of staying privileged until its session expires.
      if (user.role !== 'admin') return res.status(403).json({ error: 'admin_required' });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
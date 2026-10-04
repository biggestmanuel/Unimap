/**
 * Password hashing and session tokens.
 *
 * Uses scrypt from node:crypto rather than bcrypt/argon2: no new dependency,
 * and scrypt is memory-hard, which is the property that matters against GPU
 * cracking. Parameters are stored inside the hash so they can be raised later
 * without invalidating existing passwords.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// OWASP's scrypt baseline: N=2^16, r=8, p=1.
const PARAMS = { N: 2 ** 16, r: 8, p: 1, keylen: 32 };
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

/**
 * Constant-time string compare that tolerates differing lengths.
 *
 * Currently unused: session tokens are looked up by their SHA-256 digest, so
 * there is no secret to compare in memory. Kept because it is the correct way to
 * do this if a direct comparison is ever needed, and because removing it would
 * mean re-deriving the length-leak reasoning later.
 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still burn a comparison so the timing does not leak length.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Hash a password.
 * Encoded as `scrypt$N$r$p$saltB64$hashB64`.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    // scrypt needs roughly 128 * N * r bytes; the default 32 MB cap is below
    // what N=2^16 wants, so raise it explicitly or this throws.
    maxmem: 256 * PARAMS.N * PARAMS.r,
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row
 * should deny access, not crash the login route.
 */
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');

    const derived = await scrypt(password, salt, expected.length, {
      N, r, p, maxmem: 256 * N * r,
    });

    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** A fresh session token. 32 random bytes, URL-safe. */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored as a digest, so the database never holds a live session.
 * A plain SHA-256 is right here: the input is already 256 bits of entropy,
 * so there is nothing for a slow KDF to protect against.
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionExpiry(from = Date.now()) {
  return new Date(from + SESSION_TTL_MS);
}

export { SESSION_TTL_MS };

/**
 * Strip a user row down to what is safe to send.
 *
 * Every route that returns a user goes through this. The repositories return
 * the stored hash (they have to, to verify a password), so the leak is
 * prevented at the boundary rather than by hoping each query omits the
 * column.
 */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.display_name ?? null,
    role: user.role,
    ...(user.createdAt ?? user.created_at
      ? { createdAt: user.createdAt ?? user.created_at }
      : {}),
    ...(user.activeSessions !== undefined
      ? { activeSessions: user.activeSessions }
      : {}),
  };
}

/**
 * Password policy. Deliberately modest — this is a student app, and a policy
 * that pushes people to write `Password1!` is worse than a length rule.
 */
export function checkPasswordStrength(password) {
  const issues = [];
  if (typeof password !== 'string' || password.length < 10) {
    issues.push('use at least 10 characters');
  }
  if (typeof password === 'string' && password.length > 200) {
    issues.push('that is longer than any password should be');
  }
  return issues;
}
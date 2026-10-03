/**
 * Token-bucket rate limiting.
 *
 * In-process, per-instance, deliberately simple. Two endpoints are public by
 * design (`/api/traces`, `/api/corrections`) because a student reporting a
 * missing path should not have to register, and neither is cheap to serve:
 * a trace is up to 20,000 coordinates that get snapped against the whole
 * graph.
 *
 * Scope, honestly stated: this protects a single process and resets on
 * restart. It is enough to stop casual abuse and to stop one misbehaving
 * client from saturating the CPU. For a multi-instance deployment, put a real
 * limiter at the reverse proxy as well -- see docs/SECURITY.md.
 */

/** How many distinct clients to remember before force-evicting the oldest. */
const DEFAULT_MAX_CLIENTS = 1000;

/** Entries untouched for this long are swept, so the map cannot grow forever. */
const IDLE_MS = 10 * 60 * 1000;

/**
 * @param {object} opts
 * @param {number} opts.capacity        burst allowance, in requests
 * @param {number} opts.refillPerSecond  sustained rate
 * @param {number} opts.maxClients      hard cap on tracked clients
 */
export function createRateLimiter({
  capacity = 10,
  refillPerSecond = 1,
  maxClients = DEFAULT_MAX_CLIENTS,
} = {}) {
  /** @type {Map<string, {tokens: number, updatedAt: number}>} */
  const buckets = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < IDLE_MS) return;
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (now - b.updatedAt > IDLE_MS) buckets.delete(key);
    }
  }

  /**
   * Build the Express middleware.
   *
   * Returned as a method rather than as the export itself on purpose: if the
   * exported value were callable as middleware, Express would pass `req` as
   * the `keyOf` argument, hand back a handler instead of calling `next()`,
   * and every request would hang. Keep the two shapes distinct.
   *
   * @param {(req: import('express').Request) => string|null} [keyOf]
   *   What counts as "one client". Defaults to the remote address, which is
   *   the proxy's address unless `trust proxy` is set on the app.
   */
  function middleware(keyOf = defaultKey) {
    const rateLimit = function rateLimit(req, res, next) {
      const now = Date.now();
      sweep(now);

      const key = keyOf(req);
      if (key == null) return next();

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, updatedAt: now };
        buckets.set(key, bucket);
      } else {
        const elapsed = (now - bucket.updatedAt) / 1000;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
        bucket.updatedAt = now;
      }

      if (bucket.tokens < 1) {
        const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'rate_limited',
          message: 'Too many requests. Try again shortly.',
          retryAfterSeconds: retryAfter,
        });
        return undefined;
      }

      bucket.tokens -= 1;

      // Tell the client what it has left, so a well-behaved client can back
      // off before it gets a 429.
      res.setHeader('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));

      if (buckets.size > maxClients) {
        // The sweep should prevent this, but never let the map grow unbounded.
        buckets.delete(buckets.keys().next().value);
      }

      return next();
    };
    // The reset handle must live on the *inner* function too, because that is
    // what `.middleware()` hands out and what tests hold. Attaching it only
    // to the factory makes every reset a silent no-op, and the buckets then
    // leak between tests.
    rateLimit.reset = () => buckets.clear();
    return rateLimit;
  }

  // Self-reference so callers can write `createRateLimiter(opts).middleware()`
  // without having to keep the factory around.
  middleware.middleware = middleware;
  middleware.reset = () => buckets.clear();

  return middleware;
}

function defaultKey(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * The public-write limiter: generous enough that a student correcting several
 * places in a row never notices, tight enough that a script cannot.
 *
 * Capacity 12 with a refill of one every 10 s means a burst of reports while
 * out walking is fine, but sustained abuse runs dry.
 */
export const publicWriteLimiter = createRateLimiter({
  capacity: 12,
  refillPerSecond: 1 / 10,
}).middleware();

/** Wider net for read traffic: searching should never be throttled. */
export const readLimiter = createRateLimiter({
  capacity: 120,
  refillPerSecond: 10,
}).middleware();

/** Test seam: clears all buckets. Accepts either shape. */
export function resetLimiter(limiter) {
  if (typeof limiter === 'function') limiter.reset?.();
  else limiter?.reset?.();
}

/**
 * Clear every shared limiter.
 *
 * The exported limiters are module singletons so that a burst spread across
 * routes counts against one client. That is right in production and wrong in
 * tests, where files would otherwise throttle each other through a shared
 * module. Call this wherever a test builds a fresh app.
 */
export function resetAllLimiters() {
  resetLimiter(publicWriteLimiter);
  resetLimiter(readLimiter);
}
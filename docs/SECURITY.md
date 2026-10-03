# Security notes

Short version: there is no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`
and no string-concatenated SQL anywhere in `frontend/src` or `backend/src`.
This file records why, so a later change does not undo it accidentally.

## Why this matters here

Two of the inputs to this app are **untrusted and user-supplied**:

- POI corrections submitted by students
- Walk traces recorded by students

Both render in the admin console. Both are attacker-controlled text. That
makes XSS the obvious risk, and it is the one that actually matters — not
SQL injection, which parameterised queries already handle.

## The rules

### Never build HTML from data

POI names, descriptions, correction `detail` text, trace `note`, reviewer
names — all of it goes through `textContent`, never `innerHTML`.

`PoiMarkerLayer` is the awkward case, because Leaflet's `bindPopup` wants an
HTML *string*. The pattern used there is deliberate:

```js
// Shell is a static literal with EMPTY elements.
marker.bindPopup('<div class="poi-popup"><p class="poi-popup__name"></p>…</div>');

// Data is then written into those elements as text.
el.querySelector('.poi-popup__name').textContent = poi.name;
```

Do not "simplify" this into `bindPopup(`<h2>${poi.name}</h2>`)`. That single
change is a stored XSS in the admin console and on every student's phone.

### Grep for it

Before any review:

```bash
grep -rn "dangerouslySetInnerHTML\|innerHTML\|insertAdjacentHTML\|eval(\|new Function" \
  frontend/src backend/src
```

Expect zero hits. The only matches allowed are the word inside a comment
explaining why it is absent.

## SQL

Every query uses `pg` bound parameters. No user value is ever concatenated
into a statement string. The one place a multi-value `INSERT` is built
(`graph/src/importOsm.js`) uses numbered placeholders and pushes params in the
same order.

## Authentication

- **scrypt** (N=2^16, r=8, p=1) via `node:crypto`, no extra dependency.
  Parameters are stored inside the hash, so they can be raised later without
  invalidating existing passwords.
- **Sessions are server-side and revocable**, not stateless JWTs. An admin
  account must be killable the moment it is compromised.
- **Only the SHA-256 of a session token is stored.** A database leak therefore
  yields no live sessions. The digest is a plain SHA-256 because the input is
  already 256 bits of entropy — a slow KDF protects nothing here.
- **The session cookie is HttpOnly + SameSite=Lax**, and `Secure` in
  production. It is deliberately not in `localStorage`, which an XSS could read.
- **Login does the same work whether or not the account exists**, so response
  time does not reveal which addresses are registered.
- **Every user-returning route goes through `publicUser()`.** The repositories
  must return `password_hash` in order to verify a password, so the strip
  happens at the boundary. An earlier version of the admin "create user" route
  returned the raw row and leaked the hash; the test that caught it is
  `backend/test/auth.test.js`.

## Authorisation

`requireAdmin` is a real role check on every `/api/admin/*` and trace-review
route. There is no "closed in production" placeholder any more — the previous
`501 in production` guard only bit under `NODE_ENV=production`, which meant
development was wide open.

The **admin console is a separate build entry** and is excluded from the
service worker precache (`globIgnores` in `vite.config.js`). Students never
download it.

## Public endpoints

`POST /api/traces` and `POST /api/corrections` are intentionally open — a
student reporting a missing path should not have to register. They are bounded
by:

- Zod schemas with hard limits (a trace is capped at 20,000 points)
- the 64 KB body limit in `express.json`, which returns **413**, not 500
- geometric sanity checks (a trace that does not move is rejected)
- a token bucket, 12 burst and one request per 10 seconds

## Still to do

- **CSP headers.** Worth adding at the serving layer once the deployment
  target is known.
- **Audit `legacy/`.** It is the archived vanilla app and still uses the public
  OSRM demo server. It is not served, but it is in the repository.

## Rate limiting

The two intentionally-public endpoints are behind a token bucket
(`backend/src/lib/rateLimit.js`):

| Endpoint | Burst | Sustained |
|---|---|---|
| `POST /api/traces`, `POST /api/corrections` | 12 | 1 per 10 s |
| everything else under `/api` | 120 | 10 per second |

`Retry-After` and `X-RateLimit-Remaining` are returned, so a well-behaved
client can back off before it gets a 429.

**Scope, honestly:** in-process and per-instance. It stops casual abuse and
one misbehaving client from saturating the CPU, and it resets on restart.
For more than one instance, put a real limiter at the reverse proxy too.

`trust proxy` is set on the app (overridable with `TRUST_PROXY`). Without it
`req.ip` is the proxy's address and every client shares one bucket, so a
single busy campus could lock everyone out.

### Testing it

The limiters are module singletons, so a test file will throttle *itself*
partway through unless the buckets are cleared. Call `resetAllLimiters()`
wherever a test builds a fresh app. Getting this wrong produces failures that
look like routing bugs, which is how it was found.
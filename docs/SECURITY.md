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
- **The admin console uses a bearer token instead of that cookie**, because it is
  served from a different origin than the API. See "Cross-origin admin" below.
- **Login does the same work whether or not the account exists**, so response
  time does not reveal which addresses are registered. A disabled account
  returns the *same* `invalid_credentials` error for the same reason: saying
  "your account is disabled" would confirm the address is registered.
- **Every user-returning route goes through `publicUser()`.** The repositories
  must return `password_hash` in order to verify a password, so the strip
  happens at the boundary. An earlier version of the admin "create user" route
  returned the raw row and leaked the hash; the test that caught it is
  `backend/test/auth.test.js`.

## Cross-origin admin

The console is deployed to Vercel and the API to Render, so they are different
origins. The original design used the session cookie, which cannot work there:
a `SameSite=Lax` cookie is not sent cross-site, and `Access-Control-Allow-Origin:
*` forbids credentials outright. Both were confirmed empirically rather than
assumed.

The fix was **not** to relax the cookie. It is to send the token in the
`Authorization` header, which the backend already accepted and already returned
from `/auth/login`.

Why this is the better answer, not just the easier one:

| | `SameSite=None` cookie | Bearer header |
|---|---|---|
| Cross-site forgery | Cookie is sent **automatically** → CSRF | Token is attached deliberately → structurally impossible |
| Extra config | Exact-origin allowlist required (`*` + credentials is illegal) | None |
| Extra code | Origin checks on every state-changing route | None |

The trade-off is honest: the token lives in a JS ref, so a page reload signs the
admin out. An HttpOnly cookie would survive that, but it would also be sent
without the page's knowledge on every request to that domain. For a console
opened occasionally, re-authenticating is the better deal.

## Revocation

Sessions are server-side and revocable, and the admin console can now exercise
that. Three operations, all admin-gated, all audited:

| Endpoint | Effect |
|---|---|
| `PATCH /api/admin/users/:id` | stand an account down (`disabled_at`), or bring it back |
| `POST /api/users/:id/revoke-sessions` | kill every live token for one account |
| `DELETE /api/admin/users/:id` | remove the account; sessions cascade |

**Changing a password does not revoke sessions.** A session is keyed by its own
token hash, not by the password, so a password reset cannot kick out whoever
prompted it. That gap is why the revoke endpoint exists.

`disabled_at` is checked in **both** the login route and `resolveUser`, so
standing someone down takes effect on their next request rather than at session
expiry. Disabling also revokes sessions in the same action.

Deliberate guard rails, each tested:

- An admin cannot disable, delete or revoke **their own** account — the obvious
  mistake should not lock the console.
- The **last active admin cannot be deleted.** An empty admin set means the only
  way back is direct SQL, which is exactly what this feature exists to prevent.
- `PATCH` rejects an empty body, so a malformed request cannot silently read as
  "enable" and undo a revocation.

## Audit trail integrity

The reviewer of a moderation decision comes from the **session**, never from the
request body. Both `reviewCorrectionSchema` and `reviewTraceSchema` still accept
a `reviewer` field for backward compatibility with existing clients, but both
routes discard it.

Without that, any authenticated admin could attribute a decision to a colleague
or to an address that has never signed in — and the audit log exists precisely
to make that impossible. The test is
`backend/test/reviewerSpoofing.test.js`.

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

## Merged walk traces

A walk trace is student-supplied geometry that becomes a real `graph_edges` row,
so it deserves the same scrutiny as any other write path.

- The merge runs in **one transaction.** The edge insert and the status change
  either both land or neither does — a trace cannot be left marked merged with
  no geometry behind it, which would be unrecoverable through the API.
- `SELECT ... FOR UPDATE` on the trace, so two admins merging the same trace at
  once cannot both insert.
- Geometry is **simplified** (Douglas-Peucker, 3 m) before storage. Not
  cosmetic: `buildGraph` splits every edge at every vertex, so raw GPS jitter
  would add thousands of routing nodes per trace.
- **Endpoints are snapped** onto existing geometry within 25 m, and the distance
  moved is returned in the response. Only the two ends move — the middle of the
  walk is the new information and is left exactly as recorded. Beyond the
  tolerance nothing is touched, so two genuinely different paths are never
  silently joined.
- A trace shorter than 5 m is refused with **422**, not 500: a stationary phone
  produces valid-looking traces under a metre long.
- The row is `footpath`, never `corridor`. A hand-recorded path is a shortcut;
  calling it a backbone road would over-trust its quality. One that never meets
  the network stays inert, because the router only uses a footpath when it can
  get you back onto a corridor.
- `geometry(LineString, 4326) NOT NULL` with `CHECK (ST_NPoints(geom) >= 2)` is
  the last line of defence.

## Still to do

- **CSP headers.** Worth adding at the serving layer now that the deployment
  target is known.
- **Audit `legacy/`.** It is the archived vanilla app and still uses the public
  OSRM demo server. It is not served, but it is in the repository.
- **Rotate the Neon password.** It was set through the dashboard and shared
  during setup; treat it as known to anyone who saw it.

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
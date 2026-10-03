# Overnight Plan — UniMap

**Started:** 2026-10-03 (evening) → continuing overnight
**State at handover:** Full stack live. Student app on Vercel, API on Render, PostGIS on Neon.
**Verified working:** 324 ways (incl. 1 merged trace), routing 1235m/15min, admin console + bearer auth.

---

## Operating rules for this session

1. **Review gate after every task.** No task is "done" until it has passed its
   own review checklist and that review is recorded in the log below.
2. **Never commit a red test suite.** If a task breaks tests, the task is not finished.
3. **Push after every green task.** Work must never sit uncommitted overnight.
4. **No secrets in any file, commit message, or log.** `.env` stays gitignored.
5. **Stop and flag, don't guess**, on anything touching auth, payments, or data deletion.
6. **Leave the app deployable at all times.** Every commit must be releasable.

---

## Phase 0 — Close out tonight's session ✅

| # | Task | State |
|---|---|---|
| 0.1 | Admin account created + password rotated | ✅ done |
| 0.2 | Render redeploy verified (admin routes 200) | ✅ done |
| 0.3 | Trace submitted + merged via console | ✅ done |
| 0.4 | Temp test accounts/traces/edges purged from Neon | ✅ done |

**Phase 0 review — PASSED**
- Confirmed only 1 user in `users`, only `source='osm'` + 1 `walk-trace` edge
- Confirmed no credential appears in any tracked file
- Confirmed `git status` clean, working tree matches origin

---

## Phase 1 — Verify the merge actually connects (highest value)

**Why first:** the demo trace merged but stayed an *island*. If merge can't connect
to the network, the headline feature doesn't do what it claims. Everything else is
less important than this.

- [ ] **1.1** Submit the 2.9 m bridging trace (coordinates below)
- [ ] **1.2** Merge it via the API as admin
- [ ] **1.3** Assert islands **decrease** and routable metres **increase**
- [ ] **1.4** Assert a route exists across the newly-joined component
- [ ] **1.5** Add a regression test: a trace whose endpoints match corridor
      vertices exactly must connect (not just record)
- [ ] **1.6** Investigate: why did endpoint nodes not match? Compare
      `nodeKey()` rounding in `geo.js` against stored coordinate precision

> **Bridging trace** — joins component 0 (1083 vertices, the main network) to
> component 18 (14 vertices). Both endpoints are existing corridor vertices:
> ```
> [[6.9871737,4.7995803],[6.9871809,4.7995852],[6.9871881,4.7995902],[6.9871953,4.7995951]]
> ```

**Review gate 1 — the checklist that must pass**
- [ ] Islands count strictly decreased (was 42)
- [ ] Routable metres strictly increased
- [ ] `connectedGroups` strictly decreased (was 43)
- [ ] The joined island no longer appears in the islands table
- [ ] Regression test **fails** when the connect logic is reverted
- [ ] No test relies on live Neon (unit tests use memoryRepo)

---

## Phase 2 — Graph data quality

- [ ] **2.1** `npm run graph:gaps` → machine-readable output (JSON, not just tables)
- [ ] **2.2** Rank island gaps by size; flag any where the gap is < 2 m
      (suggests a coordinate-precision bug, not real missing data)
- [ ] **2.3** Investigate all **344 dead ends** — are they real dead ends or
      precision artefacts? This number is suspiciously high.
- [ ] **2.4** Fix precision mismatch at the source if found
      (single canonical rounding helper; no more magic numbers)
- [ ] **2.5** Add a graph-integrity test: every footpath endpoint must touch
      a corridor, or be explicitly marked as an orphan

**Review gate 2**
- [ ] Every dead end classified (real vs artefact) and written down
- [ ] Fix, if any, has a test that fails before it
- [ ] Island count did not regress
- [ ] `graph:verify` passes

---

## Phase 3 — Trace merge robustness

- [ ] **3.1** **Snap trace endpoints to nearby corridor vertices** during merge.
      This is the real fix for Phase 1 — a human walking will never hit a
      vertex coordinate exactly. Snap within ~10 m; record the snap distance.
- [ ] **3.2** Persist `snapped_m` on the edge so a bad snap is auditable
- [ ] **3.3** Reject merges whose endpoints snap > 25 m (not a real connection)
- [ ] **3.4** `DELETE /api/graph/edges/:id` — remove a bad merged edge
- [ ] **3.5** Admin UI: show the trace→edge provenance, allow undo
- [ ] **3.6** Handle a trace that crosses an existing corridor mid-way
      (currently only endpoints connect)

**Review gate 3**
- [ ] Snap distance recorded and visible in the UI
- [ ] Over-snap (>25 m) refused with 422
- [ ] Undo removes the edge *and* resets the trace to pending
- [ ] A trace that snaps to nothing is still recorded but clearly marked orphan

---

## Phase 4 — Security review (read the code, fix what's real)

- [ ] **4.1** Rate limits on the new admin endpoints (delete/disable/revoke)
- [ ] **4.2** Confirm `PUBLIC_WRITE_LIMITER` covers `POST /traces` — it's
      the only unauthenticated write and the most expensive
- [ ] **4.3** Audit log: confirm every admin action is recorded, and that it
      records **who** (the code uses `req.user.email` — verify it's never the
      client-supplied `reviewer` field)
- [ ] **4.4** Verify `reviewer` cannot be spoofed on `PATCH /traces/:id`
      — client sends it in the body, server should override from the session
- [ ] **4.5** Check `XSS` rules still hold: no `dangerouslySetInnerHTML`
      anywhere, including the new merge output
- [ ] **4.6** Confirm error messages don't leak whether an email exists
- [ ] **4.7** Dependency audit (`npm audit` both packages)
- [ ] **4.8** Confirm `TRUST_PROXY` is set on Render and rate limiting isn't
      sharing one bucket

**Review gate 4**
- [ ] **4.4 is the important one** — a spoofable `reviewer` is a real
      audit-trail hole. Fix it and add a test.
- [ ] No finding left unrecorded (even "checked, fine")
- [ ] `npm audit` clean or findings justified in writing

---

## Phase 5 — Correctness review of the pieces never exercised

- [ ] **5.1** `router.js` A* — is the heuristic admissible? An inadmissible
      heuristic returns suboptimal routes with no error.
- [ ] **5.2** Graph is built per-vertex (a deliberate, good decision). Verify
      the cost model handles two edges sharing a vertex correctly.
- [ ] **5.3** Concurrency: two admins merging the same trace simultaneously —
      the `FOR UPDATE` lock. Test it, don't assume it.
- [ ] **5.4** Postgres repo vs memoryRepo contract — I found one divergence
      (snake_case). **Systematically diff every method.** This is the single
      highest-value bug class in this codebase.
- [ ] **5.5** Rate limiter under the new endpoints

**Review gate 5**
- [ ] **5.4 must be completed** — enumerate every repo method, compare
      Postgres vs memory shapes, fix divergences, add a contract test that
      runs *both* implementations through the same assertions
- [ ] No unhandled promise rejection paths in new code
- [ ] All tests green

---

## Phase 6 — Frontend quality

- [ ] **6.1** AdminApp has **no tests at all** (confirmed). It now has the most
      logic in the project. Add tests for `mergeTrace`, `setUserDisabled`,
      `revokeSessions`, `deleteUser`.
- [ ] **6.2** Loading and error states: is there a visible failure if the API
      is down, or does it render an empty console?
- [ ] **6.3** `window.confirm` — works, but not keyboard/screen-reader ideal
- [ ] **6.4** Accessibility pass: tab order, focus rings, `aria-live` on the
      flash message
- [ ] **6.5** Offline behaviour of the admin console (it's not in the PWA
      precache — confirm that's intentional and correct)

**Review gate 6**
- [ ] AdminApp has meaningful test coverage (not snapshot theatre)
- [ ] Error states are visible, not silent
- [ ] No `alert`/`confirm` blocking flow in the student app

---

## Phase 7 — Documentation

- [ ] **7.1** `README.md` — does it exist and match reality?
- [ ] **7.2** Document the **manual-only** steps clearly (verify footpaths,
      field test over Glo data, choose tile source)
- [ ] **7.3** Document the deploy runbook: Render config, Vercel config,
      env vars, migration order
- [ ] **7.4** Update `PLAN.md` — phase status, the two bug logs
- [ ] **7.5** Document the trace-merge design decision (why footpath, not
      corridor; why endpoints are preserved)
- [ ] **7.6** `docs/SECURITY.md` — update for the revocation model

**Review gate 7**
- [ ] A stranger could deploy this from the docs alone
- [ ] Every claim in the README is verified, not assumed

---

## Phase 8 — Cleanup & final verification

- [ ] **8.1** Remove dead code (`traceRouter.js` leftover? unused exports?)
- [ ] **8.2** Run the *full* suite: backend + frontend unit + e2e
- [ ] **8.3** Verify live deployment end-to-end from a clean browser
- [ ] **8.4** Confirm Neon has no test residue
- [ ] **8.5** Final commit + push
- [ ] **8.6** Write the overnight summary: what shipped, what's still open,
      what needs a human

**Review gate 8**
- [ ] Everything green
- [ ] Live site verified working
- [ ] Summary honest about failures and unknowns

---

## Explicitly NOT doing overnight

- Choosing a tile source (needs your decision + budget)
- Verifying footpaths against reality (needs someone on campus)
- Field-testing over real Glo data (needs the hardware and a location)
- Anything involving payment, email delivery, or third-party accounts
- Deleting the `walk-trace` edge currently in the graph — **leave it**, it's
  harmless and demonstrates the feature; I'll ask before removing

---

## Log

Appended as work completes. Newest last.
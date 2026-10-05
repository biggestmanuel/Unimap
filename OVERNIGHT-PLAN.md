# Overnight Plan — UniMap

**Run:** 2026-10-03 23:50 → 2026-10-04
**Result:** all 8 phases complete. 5 commits, pushed.

---

## Phase status

| Phase | Outcome |
|---|---|
| 0 — close out the session | ✅ done before handover |
| 1 — verify merge connects | ✅ **verified it does**, and found why it hadn't |
| 2 — graph data quality | ✅ **deadEndCount was wrong** (344 → 102) |
| 3 — merge robustness | ✅ **endpoint snapping added** |
| 4 — security | ✅ **spoofable `reviewer` closed** |
| 5 — correctness | ✅ **repo contract pinned** |
| 6 — frontend quality | ✅ **22 AdminApp tests**, one real bug fixed |
| 7 — documentation | ✅ README rewritten, SECURITY updated |
| 8 — cleanup + verification | ✅ full suite green, DB clean |

---

## What was actually wrong

Five defects, four of which had been invisible.

**1. Merged traces never connected.** A trace had to land on an exact vertex to
join the network, and a person walking with a phone never stops on a surveyed
one — GPS error alone is several metres. Every genuine recording became another
island: the map looked improved and nothing had become routable. Endpoints are
now snapped within 25 m, and the distance moved is returned so a suspicious merge
is visible. Only the ends move; the middle of the walk is the new information.

Measured on Neon: a trace 6 m off the network now connects (39,141 m → 40,442 m
routable); one 60 m off still correctly becomes an island.

**2. `deadEndCount` was meaningless.** It counted way *endpoints*, reporting 344
dead ends across 323 ways — more dead ends than ways, because any way meeting
another partway along looked like it ended at both ends. It now counts link
degree, which is what the router's adjacency actually is: 102, and the two now
agree by construction. Tests assert the agreement.

**3. `reviewer` was client-supplied.** Both moderation routes took the reviewer
from the request body while the route already knew who was signed in, so an
admin could attribute a decision to a colleague or to an address that has never
logged in. Now taken from the session.

**4. The repositories had drifted.** `postgresRepo` returned raw snake_case rows
while `resolveUser` read camelCase — which is why admin login 401'd against Neon
while the whole suite stayed green. `test/repoContract.test.js` now drives
postgresRepo through a fake pool and pins its output shapes.

**5. A mistyped password said "not_authenticated".** The 401 handler assumed every
401 was an expired session. Found by writing the AdminApp tests.

Plus one flaky test with a real cause: the e2e cache helper's bare
`indexedDB.open('unimap')` could beat the app's own versioned open, creating an
empty database so `onupgradeneeded` never fired and the app silently cached
nothing. Now 12/12 consecutive passes where before it failed about half the time.

---

## Test totals

| Suite | Before | After |
|---|---|---|
| Backend | 212 | **251** |
| Frontend unit | 168 | **190** |
| E2E | 46 (1 flaky) | **46 (stable)** |

All green. Neon left with 1 user, 79 POIs, 324 edges (323 OSM + 1 merged demo),
1 merged trace, no test residue.

---

## Known limitations, stated plainly

**All four are fixed.** They were listed here when this file was written; the
fixes landed the following session.

- ~~A branch meeting another way's interior is not connected.~~ Fixed:
  `buildGraph` now splits a way where a foreign vertex lands mid-segment. OSM
  already splits at shared nodes so the campus data is unchanged byte for byte;
  merged traces now attach properly.
- ~~`purgeExpiredSessions` is never called.~~ Fixed: swept hourly from
  `server.js`, unref'd, errors logged rather than thrown.
- ~~CSP headers absent.~~ Fixed: `backend/src/lib/csp.js`, applied before any
  handler so error paths carry them too.
- ~~Dead code, not removed.~~ Partly: `sliceLine` deleted. `pointInPolygon` and
  `safeEqual` are exported and untested, so deleting them would have removed 17
  lines of coverage — they gained tests and a comment explaining why they are
  kept instead.

### Still true

- **Endpoints can only snap to existing geometry.** A trace ending in open ground
  stays an island. That is intended — see `test/snap.test.js`.
- **Two ways that merely cross, with neither ending at the crossing, are not
  joined.** That is an overpass, and joining them would route people over a
  bridge. Pinned by `test/interiorJunction.test.js`.

---

## Still needs a person

1. Walk the campus and check the footpaths. 41 islands remain; cheapest gap 46 m.
2. Check the POIs that sit off the network.
3. Field-test over real Glo data — never done.
4. Choose a tile source. Public OSM tiles will rate-limit real traffic.
5. Verify the Neon password in the console.
6. Rotate the Neon password — it was shared during setup.
import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke test for the Phase 1 slice:
 * load -> markers -> search -> select -> filter.
 *
 * The geojson fetch is stubbed so the spec asserts app behaviour and
 * not the current contents of the campus data.
 */
const FIXTURE = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { Name: 'Faculty of Engineering', category: 'faculty' }, geometry: { type: 'Point', coordinates: [6.98, 4.79] } },
    { type: 'Feature', properties: { Name: 'NEH', category: 'academic' }, geometry: { type: 'Point', coordinates: [6.982, 4.792] } },
    { type: 'Feature', properties: { Name: 'Hostel A', category: 'hostel' }, geometry: { type: 'Point', coordinates: [6.984, 4.794] } },
  ],
};

async function stubData(page) {
  await page.route('**/data/unimap.geojson', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) }),
  );
}

test.beforeEach(async ({ page }) => {
  await stubData(page);
  await page.goto('/');
});

test('loads and reports the campus location count', async ({ page }) => {
  await expect(page.getByRole('status').filter({ hasText: '3 locations' })).toBeVisible();
});

test('the skeleton loader disappears once data arrives', async ({ page }) => {
  await expect(page.getByText(/preparing campus map/i)).toBeHidden();
});

test('renders a marker per POI', async ({ page }) => {
  await expect(page.locator('.poi-marker')).toHaveCount(3);
});

test('opens the search sheet from the trigger', async ({ page }) => {
  await page.getByRole('button', { name: /where are you headed/i }).click();
  await expect(page.getByRole('searchbox', { name: /search locations/i })).toBeVisible();
});

test('searches and selects a POI', async ({ page }) => {
  await page.getByRole('button', { name: /where are you headed/i }).click();
  await page.getByRole('searchbox').fill('faculty');
  await expect(page.getByRole('button', { name: /faculty of engineering/i })).toBeVisible();
  await page.getByRole('button', { name: /faculty of engineering/i }).click();
  // Selecting closes the sheet and highlights the marker.
  await expect(page.getByRole('searchbox')).toBeHidden();
  await expect(page.locator('.poi-marker-wrapper.is-selected')).toHaveCount(1);
});

test('filters markers by category', async ({ page }) => {
  await page.getByRole('button', { name: /where are you headed/i }).click();

  // Scope to the filter group: emoji prefixes make accessible-name
  // matching brittle across runners.
  const group = page.getByRole('group', { name: /filter by type/i });
  await group.getByRole('button', { name: /Hostel/ }).click();

  await page.getByRole('searchbox').fill('');

  // The filter dims the Leaflet icon wrapper, not the inner glyph div.
  const wrappers = page.locator('.poi-marker-wrapper');
  await expect(wrappers).toHaveCount(3); // all present, non-matching are dimmed

  const opacities = await wrappers.evaluateAll((els) => els.map((e) => e.style.opacity));
  expect(opacities.filter((o) => o === '0.15')).toHaveLength(2);
  expect(opacities.filter((o) => o === '1')).toHaveLength(1);
});

test('shows an empty state for a miss', async ({ page }) => {
  await page.getByRole('button', { name: /where are you headed/i }).click();
  await page.getByRole('searchbox').fill('zzzzz');
  await expect(page.getByText(/no match for/i)).toBeVisible();
});

/**
 * Make IndexedDB unavailable for this page.
 *
 * Used to test the "nothing cached, network broken" path deterministically.
 * It also mirrors a real scenario the cache has to survive: private browsing
 * on iOS, where `indexedDB` is genuinely missing.
 */
async function withoutIndexedDb(page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  });
}

/**
 * Read a value from the app's IndexedDB, without ever *creating* the database.
 *
 * The obvious implementation -- `indexedDB.open('unimap')` -- is a trap. Omitted
 * a version, it opens at version 1 and CREATES an empty database if none
 * exists. If that beats the app's own `indexedDB.open('unimap', 1)`, the app
 * then finds version 1 already present, `onupgradeneeded` never fires, and the
 * `pois` store is never created. The app silently caches nothing, and any test
 * waiting on the cache then fails for reasons that look nothing like its cause.
 * That is what made this spec flaky at roughly one run in three.
 *
 * `indexedDB.databases()` lets us look before we leap.
 */
function readStore(page, store, key) {
  return page.evaluate(
    ({ store, key }) => new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);

      indexedDB.databases().then((dbs) => {
        const exists = dbs.some((d) => d.name === 'unimap');
        if (!exists) return resolve(null); // not created yet; caller retries

        const req = indexedDB.open('unimap');
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            return resolve(null);
          }
          const get = db.transaction(store, 'readonly').objectStore(store).get(key);
          get.onsuccess = () => {
            db.close();
            resolve(get.result ?? null);
          };
          get.onerror = () => {
            db.close();
            resolve(null);
          };
        };
        return undefined;
      }).catch(() => resolve(null));
    }),
    { store, key },
  );
}

/** Wait until the app has actually written the POI cache. */
async function waitForCache(page) {
  // Polled from Node, not from inside the page. An in-page waitForFunction
  // re-runs its body on a timer and can leave a database connection or an open
  // transaction behind between attempts, which on the emulated mobile profile
  // was enough to make `indexedDB.databases()` block -- so the poll timed out
  // intermittently on one profile only. Each attempt here opens, reads, closes.
  await expect
    .poll(async () => Boolean(await readStore(page, 'pois', 'campus')), {
      timeout: 15000,
      intervals: [250, 250, 500, 500, 1000],
    })
    .toBe(true);
}

test('shows the error state when the data fails and nothing can be cached', async ({ page }) => {
  await withoutIndexedDb(page);
  await page.unroute('**/data/unimap.geojson');
  await page.route('**/data/unimap.geojson', (route) => route.fulfill({ status: 500, body: 'nope' }));
  await page.reload();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
});

test('falls back to saved data when the network fails, and says so', async ({ page }) => {
  // The realistic case: the student has used the app before and now has no
  // signal, so IndexedDB holds the campus directory.
  await waitForCache(page);
  const cached = await readStore(page, 'pois', 'campus');
  // Fail loudly and immediately if the cache is not the three-POI fixture.
  // Otherwise this test waits out the full timeout on a text that cannot
  // appear, and reports a symptom instead of the cause.
  expect(cached, 'the campus record should be cached before the reload').toBeTruthy();

  await page.unroute('**/data/unimap.geojson');
  await page.route('**/data/unimap.geojson', (route) => route.fulfill({ status: 500, body: 'nope' }));
  await page.reload();

  // The campus still loads...
  await expect(page.getByText(/3 locations/)).toBeVisible();
  // ...but the user is told it is saved data, not live. Deliberately does not
  // claim they are offline: the origin can be down while the browser is fine.
  await expect(page.getByText(/showing saved campus data/i)).toBeVisible();
  await expect(page.getByText(/could not reach the server/i)).toBeVisible();
  await expect(page.getByText(/you are offline/i)).toHaveCount(0);
  // And no error card, because this is a recovery rather than a failure.
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('recovers when the network comes back and the retry succeeds', async ({ page }) => {
  await withoutIndexedDb(page);
  await page.unroute('**/data/unimap.geojson');

  let failing = true;
  await page.route('**/data/unimap.geojson', (route) =>
    (failing
      ? route.fulfill({ status: 500, body: 'nope' })
      : route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE),
      })),
  );
  await page.reload();

  await expect(page.getByRole('alert')).toBeVisible();

  failing = false;
  await page.getByRole('button', { name: /try again/i }).click();

  await expect(page.getByText(/3 locations/)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
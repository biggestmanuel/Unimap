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

/** Wait until the app has actually written the POI cache. */
async function waitForCache(page) {
  await page.waitForFunction(
    () => new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(false);
      const req = indexedDB.open('unimap');
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pois')) return resolve(false);
        const get = db.transaction('pois', 'readonly').objectStore('pois').get('campus');
        get.onsuccess = () => resolve(Boolean(get.result));
        get.onerror = () => resolve(false);
      };
    }),
    null,
    { timeout: 10000 },
  );
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

  await page.unroute('**/data/unimap.geojson');
  await page.route('**/data/unimap.geojson', (route) => route.fulfill({ status: 500, body: 'nope' }));
  await page.reload();

  // The campus still loads...
  await expect(page.getByText(/3 locations/)).toBeVisible();
  // ...but the user is told it is saved data, not live.
  await expect(page.getByText(/showing saved campus data/i)).toBeVisible();
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
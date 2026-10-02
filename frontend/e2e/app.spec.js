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

test('shows the error state and retries when data fails', async ({ page }) => {
  await page.unroute('**/data/unimap.geojson');
  await page.route('**/data/unimap.geojson', (route) => route.fulfill({ status: 500, body: 'nope' }));
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
});
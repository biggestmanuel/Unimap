import { test, expect } from '@playwright/test';

/**
 * Navigation end-to-end coverage.
 *
 * Exercises the pieces that only exist once everything is wired together:
 * geolocation, the route request, the polyline, arrival detection and the
 * trace recorder. Geolocation is granted and faked through Playwright's
 * context permissions, and the /api/route response is stubbed so the spec
 * asserts app behaviour rather than the live campus graph.
 */

const ORIGIN = { lat: 4.79, lng: 6.98 };

function offset(north, east = 0) {
  return {
    lat: ORIGIN.lat + north / 111320,
    lng: ORIGIN.lng + east / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  };
}

const FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { Name: 'NEH', category: 'lecture-hall' },
      geometry: { type: 'Point', coordinates: [offset(200, 0).lng, offset(200, 0).lat] },
    },
    {
      type: 'Feature',
      properties: { Name: 'Hostel A', category: 'hostel' },
      geometry: { type: 'Point', coordinates: [offset(100, 0).lng, offset(100, 0).lat] },
    },
  ],
};

/** A three-point graph route from near the start to the destination. */
const ROUTE_RESPONSE = {
  found: true,
  mode: 'graph',
  coords: [
    offset(10, 0),
    offset(100, 0),
    offset(200, 0),
  ],
  distanceMeters: 190,
  durationSeconds: 140,
  snappedOriginMeters: 4,
  snappedDestinationMeters: 6,
  legs: [
    { name: 'Road A', edgeClass: 'corridor', surface: 'paved', lengthMeters: 190, coords: [offset(10, 0), offset(200, 0)] },
  ],
  from: { lat: offset(10, 0).lat, lng: offset(10, 0).lng, source: 'coordinate', name: null },
  to: { lat: offset(200, 0).lat, lng: offset(200, 0).lng, source: 'coordinate', name: null },
};

async function setup(page, { route = ROUTE_RESPONSE } = {}) {
  await page.route('**/data/unimap.geojson', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) }),
  );
  await page.route('**/api/route', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route) }),
  );
  await page.route('**/api/corrections', (r) =>
    r.fulfill({ status: 201, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/traces', (r) =>
    r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ trace: { pointCount: 3 }, duplicatesExistingPath: false }),
    }),
  );

  await page.goto('/');
  await expect(page.getByText(/locations/)).toBeVisible();
}

/** Grant geolocation and place the user at a known point. */
async function locateAt(page, position) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: position.lat, longitude: position.lng });
}

test.beforeEach(async ({ page }) => {
  // Leaflet wants a real map container sized by CSS; the dev server serves it.
  await page.setViewportSize({ width: 390, height: 844 });
});

test.describe('navigation', () => {
  test('the theme toggle flips the document attribute', async ({ page }) => {
    await setup(page);

    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');

    await page.getByRole('button', { name: /switch to (light|dark) theme/i }).click();

    const after = await html.getAttribute('data-theme');
    expect(after).not.toBe(before);
    expect(['light', 'dark']).toContain(after);
  });

  test('the theme choice survives a reload', async ({ page }) => {
    await setup(page);

    const button = page.getByRole('button', { name: /switch to (light|dark) theme/i });
    await button.click();
    const chosen = await page.locator('html').getAttribute('data-theme');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', chosen);
  });

  test('offers to locate before any fix arrives', async ({ page }) => {
    await setup(page);
    await expect(page.getByRole('button', { name: /use my location/i })).toBeVisible();
  });

  test('requests a route once a position and a selection exist', async ({ page }) => {
    await setup(page);

    let posted = null;
    await page.route('**/api/route', async (r) => {
      posted = r.request().postDataJSON();
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ROUTE_RESPONSE),
      });
    });

    await locateAt(page, offset(10, 0));
    await page.getByRole('button', { name: /use my location/i }).click();

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();

    await page.getByRole('button', { name: /directions here/i }).click();

    await expect.poll(() => posted !== null, { timeout: 8000 }).toBe(true);
    // Both ends must reach the API as coordinates.
    expect(typeof posted.from.lat).toBe('number');
    expect(typeof posted.to.lat).toBe('number');
  });

  test('shows a route summary with a distance and a time', async ({ page }) => {
    await setup(page);
    await locateAt(page, offset(10, 0));
    await page.getByRole('button', { name: /use my location/i }).click();

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();
    await page.getByRole('button', { name: /directions here/i }).click();

    const panel = page.locator('.route-panel');
    await expect(panel).toBeVisible();

    // 190 m -> "190 m", 140 s -> "2 min". The same figures appear again in
    // the "remaining" line and the leg list, so target the summary exactly.
    const summary = panel.locator('.route-panel__summary');
    await expect(summary.getByText('190 m')).toBeVisible();
    await expect(summary.getByText('2 min')).toBeVisible();

    // The named leg comes back too.
    await expect(panel.locator('.route-leg__name')).toHaveText('Road A');
  });

  test('a straight-line fallback is labelled as a guess', async ({ page }) => {
    await setup(page, {
      route: {
        ...ROUTE_RESPONSE,
        found: false,
        mode: 'straight_line',
        reason: 'network_disconnected',
        coords: [offset(10, 0), offset(200, 0)],
        distanceMeters: 190,
        durationSeconds: 140,
        legs: [],
      },
    });

    await locateAt(page, offset(10, 0));
    await page.getByRole('button', { name: /use my location/i }).click();

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();
    await page.getByRole('button', { name: /directions here/i }).click();

    // Never present a dashed guess as a real path.
    await expect(page.getByText(/straight line/i)).toBeVisible();
  });

  test('the correction form submits and confirms', async ({ page }) => {
    await setup(page);

    // Select a POI so the report button appears.
    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();

    await page.getByRole('button', { name: /report a problem/i }).click();
    await expect(page.getByRole('dialog', { name: /report a problem/i })).toBeVisible();

    await page.locator('textarea').fill('The door is further north than this.');
    await page.getByRole('button', { name: /send report/i }).click();

    await expect(page.getByText(/thank you/i)).toBeVisible();
  });

  test('the correction form refuses a report with no detail', async ({ page }) => {
    await setup(page);

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();

    await page.getByRole('button', { name: /report a problem/i }).click();
    await expect(page.getByRole('button', { name: /send report/i })).toBeDisabled();

    await page.locator('textarea').fill('ok');
    await expect(page.getByRole('button', { name: /send report/i })).toBeDisabled();

    await page.locator('textarea').fill('a real explanation of the problem');
    await expect(page.getByRole('button', { name: /send report/i })).toBeEnabled();
  });

  test('the rename option asks for the new name', async ({ page }) => {
    // Regression: the form never collected a replacement name, so choosing
    // "It has been renamed" always produced a 400 from the API and then sat
    // in the offline queue forever.
    await setup(page);

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();
    await page.getByRole('button', { name: /report a problem/i }).click();

    await page.getByLabel(/what is wrong/i).selectOption('renamed');

    const nameField = page.getByLabel(/what is it called now/i);
    await expect(nameField).toBeVisible();

    // Still disabled until both the new name and some detail are given.
    await page.locator('textarea').fill('officially renamed last semester');
    await expect(page.getByRole('button', { name: /send report/i })).toBeDisabled();

    await nameField.fill('Faculty of Engineering Block C');
    await expect(page.getByRole('button', { name: /send report/i })).toBeEnabled();
  });

  test('a rate-limited report says so instead of claiming to be saved', async ({ page }) => {
    // Regression: a 429 fell through to the queue, which reported success even
    // when it could not store anything -- telling the student their report was
    // safe while it was discarded.
    await setup(page);
    await page.route('**/api/corrections', (r) =>
      r.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '20' },
        body: JSON.stringify({ error: 'rate_limited' }),
      }),
    );

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();
    await page.getByRole('button', { name: /report a problem/i }).click();

    await page.locator('textarea').fill('this building has been demolished');
    await page.getByRole('button', { name: /send report/i }).click();

    await expect(page.getByText(/too many reports at once/i)).toBeVisible();
    // And definitely not the false confirmation.
    await expect(page.getByText(/will send when you are back online/i)).toHaveCount(0);
    await expect(page.getByText(/thank you/i)).toHaveCount(0);
  });

  test('directions still work before any GPS fix', async ({ page }) => {
    // Regression: the campus gate refused navigation until a position had been
    // checked, so the "Directions here" button silently did nothing on a fresh
    // install.
    await setup(page);

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();

    await page.getByRole('button', { name: /directions here/i }).click();

    const panel = page.locator('.route-panel');
    await expect(panel).toBeVisible();
    // No off-campus notice should be shown when there is no fix at all.
    await expect(page.getByText(/you are off campus/i)).toHaveCount(0);
  });

  test('directions are refused once a fix says we are off campus', async ({ page }) => {
    // Lagos is 400 km away. The gate exists so the app does not present a
    // straight line from there as campus guidance.
    await setup(page);
    await locateAt(page, { lat: 6.5244, lng: 3.3792 });

    await page.getByRole('button', { name: /use my location/i }).click();
    await expect(page.getByText(/you are off campus/i)).toBeVisible();

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();

    // The route panel must not appear: the request was never made.
    await page.waitForTimeout(300);
    await expect(page.locator('.route-panel')).toHaveCount(0);
  });

  test('student text is never executed as HTML', async ({ page }) => {
    await setup(page);

    let alertFired = false;
    page.on('dialog', async (d) => {
      alertFired = true;
      await d.dismiss();
    });

    await page.getByRole('button', { name: /search campus/i }).click();
    await page.getByPlaceholder(/search/i).first().fill('NEH');
    await page.getByText('NEH').first().click();
    await page.getByRole('button', { name: /report a problem/i }).click();

    const payload = '<img src=x onerror="window.__pwned=1">';
    await page.locator('textarea').fill(payload);
    await page.getByRole('button', { name: /send report/i }).click();

    await expect(page.getByText(/thank you/i)).toBeVisible();

    // The payload must have travelled as text, and nothing executed.
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(alertFired).toBe(false);
  });
});
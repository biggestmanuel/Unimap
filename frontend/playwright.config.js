import { defineConfig, devices } from '@playwright/test';

/**
 * The e2e dev server runs on its own port, matching vite.config.js.
 *
 * It must NOT be 5173: several projects on this machine default to that, and
 * `reuseExistingServer` then silently ran this suite against a different app's
 * dev server. Tests that pass against the wrong application are worse than
 * tests that fail.
 */
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Generous, because some assertions here wait on deliberate backoff.
    // The app retries a failed fetch three times with 600 ms then 1200 ms
    // delays before it falls back to cached data, so the offline-recovery
    // tests need longer than Playwright's 5 s default on a loaded machine --
    // and a test that flakes here is a test people learn to ignore.
    expect: { timeout: 15000 },
  },

  projects: [
    // The primary target: mid-range Android on a campus network.
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    // Always start our own. Reusing whatever happens to be listening is how
    // this suite ended up testing someone else's app.
    reuseExistingServer: false,
    timeout: 120000,
  },
});
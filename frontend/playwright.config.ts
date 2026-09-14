import { defineConfig, devices } from '@playwright/test';

// Starts an isolated backend (:8010) and Vite dev server (:3010) for the dashboard E2E tests.
// Locally, `PW_CHANNEL=chrome npm run test:e2e` uses the installed Chrome instead of a downloaded browser.
const PYTHON = process.env.PYTHON ?? 'python3';
const API_PORT = Number(process.env.E2E_API_PORT ?? 8010);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3010);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1600, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 }, channel: process.env.PW_CHANNEL } },
  ],
  webServer: [
    {
      command: `${PYTHON} -m uvicorn satellite_api.main:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ACM_ARCHIVE: '0', ACM_IGNORE_SAVED_CONFIG: '1', PYTHONUNBUFFERED: '1' },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});

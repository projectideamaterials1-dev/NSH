import { expect, test, type APIRequestContext } from '@playwright/test';

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 8010}`;
const MU = 398600.4418;
const RE = 6378.137;
const ISTRAC = { lat: 13.0333, lon: 77.5167 };

function gmst(ts: number) {
  const d = ts / 86400 + 2440587.5 - 2451545.0;
  return ((((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24) * 15 * Math.PI / 180;
}

/** Circular 550 km orbit state directly above a ground point at `ts` (mirrors acm/scenario.py). */
function stateOver(latDeg: number, lonDeg: number, ts: number) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180 + gmst(ts);
  const r = RE + 550;
  const pos = [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const up = pos.map(c => c / r);
  const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
  const dir = north.map((n, i) => 0.8 * n + 0.6 * east[i]);
  const norm = Math.hypot(...dir);
  const v = Math.sqrt(MU / r);
  return { r: { x: pos[0], y: pos[1], z: pos[2] }, v: { x: dir[0] / norm * v, y: dir[1] / norm * v, z: dir[2] / norm * v } };
}

async function seed(request: APIRequestContext) {
  const ts = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
  const objects: any[] = [{ id: 'SAT-E2E-00', type: 'SATELLITE', ...stateOver(ISTRAC.lat, ISTRAC.lon, ts) }];
  for (let i = 1; i < 8; i++) objects.push({ id: `SAT-E2E-0${i}`, type: 'SATELLITE', ...stateOver(-50 + i * 12, -170 + i * 45, ts) });
  for (let i = 0; i < 300; i++) objects.push({ id: `DEB-E2E-${i}`, type: 'DEBRIS', ...stateOver(-60 + (i * 37) % 120, -180 + (i * 53) % 360, ts) });
  const res = await request.post(`${API}/api/telemetry`, { data: { timestamp: '2026-01-01T00:00:00.000Z', objects } });
  expect(res.ok()).toBeTruthy();
}

test.describe.serial('mission control dashboard', () => {
  test('renders the shell and data once telemetry arrives', async ({ page, request }) => {
    const health = await (await request.get(`${API}/health`)).json();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Crimson Nebula' })).toBeVisible();
    if (!health.engine_ready) {
      await expect(page.getByText('Waiting for telemetry')).toBeVisible();
    }
    await seed(request);
    await expect(page.getByRole('button', { name: /SAT-E2E-00/ }).first()).toBeVisible();
    await expect(page.getByText('Waiting for telemetry')).toBeHidden();
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('selecting a satellite shows live details and ground passes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /SAT-E2E-00/ }).first().click();
    const panel = page.locator('aside').first();
    await expect(panel.getByText('SAT-E2E-00', { exact: true })).toBeVisible();
    await expect(panel.getByText('Altitude')).toBeVisible();
    await expect(panel.getByText(/55\d\.\d km/)).toBeVisible();
    await expect(panel.getByText('In contact', { exact: true })).toBeVisible();
    await expect(panel.getByText(/ISTRAC Bengaluru/).first()).toBeVisible();
  });

  test('plans, schedules and cancels a manual burn', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /SAT-E2E-00/ }).first().click();
    await page.getByRole('button', { name: 'Burn', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Plan burn · SAT-E2E-00')).toBeVisible();
    await expect(dialog.getByText('Ready to schedule')).toBeVisible();
    await expect(dialog.getByText('Apogee altitude')).toBeVisible();
    await dialog.getByRole('button', { name: 'Schedule burn' }).click();
    await expect(dialog.getByText(/Scheduled MAN-SAT-E2E-00/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    const panel = page.locator('aside').first();
    await expect(panel.getByText('Queued burns (1)')).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByText('Queued burns (0)')).toBeVisible();
  });

  test('operations tabs, 3D globe and settings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /SAT-E2E-00/ }).first()).toBeVisible();

    await page.getByRole('tab', { name: /Threats/ }).click();
    await expect(page.getByRole('button', { name: /Screen now/ })).toBeVisible();
    await page.getByRole('tab', { name: /Alerts/ }).click();
    await expect(page.getByText(/Telemetry ingested/).first()).toBeVisible();
    await page.getByRole('tab', { name: /Score/ }).click();
    await expect(page.getByText('Collisions avoided')).toBeVisible();

    await page.getByRole('radio', { name: /3D Earth/ }).click();
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
    await page.getByRole('radio', { name: /2D map/ }).click();
    await expect(page.getByRole('button', { name: 'World', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Simulation settings')).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply settings' }).click();
    await expect(dialog.getByText('Settings applied.')).toBeVisible();
  });

  test('running the simulation advances the clock', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /SAT-E2E-00/ }).first()).toBeVisible();
    const clock = page.locator('header .tabular').first();
    const before = await clock.textContent();
    await page.getByRole('button', { name: '+60 s' }).click();
    await expect(clock).not.toHaveText(before ?? '');
  });
});

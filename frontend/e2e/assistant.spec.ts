import { expect, test } from '@playwright/test';

// The assistant panel against a scripted model: /api/assistant/* is mocked so the test is
// deterministic and needs no GPU or Ollama. The action an answer proposes must only run when
// the operator clicks Confirm, against the normal dashboard endpoint.

const STATUS = { provider: 'ollama', url: 'mock', model: 'qwen3:8b', reachable: true, installed: true, loaded: true };

const REPLY = {
  answer: 'The riskiest conjunction is **CDM-00042** (SAT-X vs DEB-7) with pc 2.1e-3.\n\n- A screening is ready for you to confirm.',
  thinking: null,
  model: 'qwen3:8b',
  stopped: 'answer',
  duration_s: 1.2,
  tool_calls: [{ name: 'list_conjunctions', arguments: { limit: 5 }, result: { conjunctions: [] } }],
  actions: [{
    action_id: 'act-1', kind: 'screen_now', title: 'Run conjunction screening now', params: {}, preview: { horizon: 'default' },
    valid: true, warnings: [], expires: null, confirm_window: null,
  }],
  grounding: { checked: 2, issues: [], citations: {} },
};

test.describe('operator assistant', () => {
  test('answers, shows the proposed action, and runs it only on Confirm', async ({ page }) => {
    let screenCalls = 0;
    let chatBody: any = null;
    await page.route('**/api/assistant/status', r => r.fulfill({ json: STATUS }));
    await page.route('**/api/assistant/chat', async r => {
      chatBody = r.request().postDataJSON();
      await r.fulfill({ json: REPLY });
    });
    await page.route('**/api/conjunctions/screen', async r => {
      screenCalls += 1;
      await r.fulfill({ json: { screened: true } });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Assistant' }).click();
    const panel = page.getByLabel('Operator assistant');
    await expect(panel).toBeVisible();

    await panel.getByLabel('Message the assistant').fill('What is the riskiest conjunction right now?');
    await panel.getByLabel('Message the assistant').press('Enter');

    await expect(panel.getByText('CDM-00042', { exact: false }).first()).toBeVisible();
    expect(chatBody.messages.at(-1)).toEqual({ role: 'user', content: 'What is the riskiest conjunction right now?' });
    await expect(panel.getByText('Proposed action · needs your confirmation')).toBeVisible();
    await expect(panel.getByText('Run conjunction screening now')).toBeVisible();
    expect(screenCalls).toBe(0);                          // proposing executes nothing

    await panel.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => screenCalls).toBe(1);
    await expect(panel.getByRole('button', { name: 'Confirm' })).toBeHidden();
  });

  test('dismissing a proposed action never calls the endpoint', async ({ page }) => {
    let screenCalls = 0;
    await page.route('**/api/assistant/status', r => r.fulfill({ json: STATUS }));
    await page.route('**/api/assistant/chat', r => r.fulfill({ json: REPLY }));
    await page.route('**/api/conjunctions/screen', async r => { screenCalls += 1; await r.fulfill({ json: {} }); });

    await page.goto('/');
    await page.getByRole('button', { name: 'Assistant' }).click();
    const panel = page.getByLabel('Operator assistant');
    await panel.getByLabel('Message the assistant').fill('Run a screening');
    await panel.getByRole('button', { name: 'Send' }).click();
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(panel.getByText('Dismissed: Run conjunction screening now')).toBeVisible();
    expect(screenCalls).toBe(0);
  });
});

test.describe('layout controls', () => {
  test('side panels collapse to rails, M toggles map-only, and the choice survives a reload', async ({ page }) => {
    await page.goto('/');
    const left = page.getByRole('complementary', { name: 'Selected satellite' });
    const right = page.getByRole('complementary', { name: 'Operations' });
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();

    await page.getByRole('button', { name: 'Collapse Satellite panel' }).click();
    await expect(left).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand Satellite panel' })).toBeVisible();

    await page.locator('body').press('m');                // left already hidden -> map only
    await expect(right).toBeHidden();
    await expect(page.getByRole('button', { name: 'Map only' })).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(left).toBeHidden();
    await expect(right).toBeHidden();

    await page.locator('body').press('m');                // restore both
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fullscreen' })).toBeVisible();
  });
});

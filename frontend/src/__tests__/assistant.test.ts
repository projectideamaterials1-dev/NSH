import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAssistantStore, {
  actionExpired, confirmBlocked, historyForRequest, type ChatReply, type ProposedAction,
} from '../store/assistant';

type Call = { url: string; method: string; body: any };
let calls: Call[];

/** Routes fetch by URL; every call is recorded. */
function mockFetch(routes: Record<string, (body: any) => [number, unknown]>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init.method ?? 'GET', body });
    const key = Object.keys(routes).find(k => url.startsWith(k));
    const [status, json] = key ? routes[key](body) : [200, {}];
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  }));
}

const reply = (overrides: Partial<ChatReply> = {}): ChatReply => ({
  answer: 'CDM-00018 is the riskiest.', thinking: null, model: 'qwen3:8b', stopped: 'answer', duration_s: 5,
  tool_calls: [], actions: [], grounding: { checked: 0, issues: [], citations: {} }, ...overrides,
});

const burn: ProposedAction = {
  action_id: 'ACT-1', kind: 'manual_burn', title: 'burn', valid: true, warnings: [], expires: '2026-10-10T23:40:00Z',
  params: { satellite_id: 'SAT-A', burns: [{ burnTime: '2026-10-10T23:40:00Z', frame: 'RTN', dv_mps: { t: -1.5 } }] },
  preview: {},
};

beforeEach(() => useAssistantStore.setState({ messages: [], pending: false, think: false, actionStates: {}, status: null }));
afterEach(() => vi.unstubAllGlobals());

describe('assistant helpers', () => {
  it('sends text turns only, drops failed turns and caps the history', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }));
    msgs.push({ role: 'assistant', content: '', error: 'HTTP 503' } as any);
    const h = historyForRequest(msgs);
    expect(h).toHaveLength(20);
    expect(h[19]).toEqual({ role: 'user', content: 'm24' });
  });

  it('expires actions whose time has passed in simulation time', () => {
    expect(actionExpired(burn, '2026-10-10T23:39:59Z')).toBe(false);
    expect(actionExpired(burn, '2026-10-10T23:40:00Z')).toBe(true);
    expect(actionExpired({ ...burn, expires: null }, '2030-01-01T00:00:00Z')).toBe(false);
    expect(actionExpired(burn, null)).toBe(false);
  });

  it('allows Confirm only inside the ground-contact window', () => {
    const windowed = { ...burn, confirm_window: { from: '2026-10-10T23:20:00Z', until: '2026-10-10T23:30:00Z', stations: ['GS-1'] } };
    expect(confirmBlocked(windowed, '2026-10-10T23:19:59Z')).toMatch(/Confirm opens at 23:20:00Z/);
    expect(confirmBlocked(windowed, '2026-10-10T23:25:00Z')).toBeNull();
    expect(confirmBlocked(windowed, '2026-10-10T23:30:01Z')).toMatch(/contact closed/);
    expect(confirmBlocked(windowed, '2026-10-10T23:40:00Z')).toMatch(/Expired/);
    expect(confirmBlocked({ ...windowed, valid: false }, '2026-10-10T23:25:00Z')).toMatch(/rejected/);
    expect(confirmBlocked(burn, '2026-10-10T23:00:00Z')).toBeNull();
  });
});

describe('assistant store', () => {
  it('sends the conversation and the think flag, and appends the reply', async () => {
    mockFetch({ '/api/assistant/chat': () => [200, reply()] });
    useAssistantStore.getState().setThink(true);
    await useAssistantStore.getState().send('  which is riskiest?  ');
    const [chat] = calls;
    expect(chat.method).toBe('POST');
    expect(chat.body).toEqual({ messages: [{ role: 'user', content: 'which is riskiest?' }], think: true });
    const { messages, pending } = useAssistantStore.getState();
    expect(pending).toBe(false);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'CDM-00018 is the riskiest.' });
  });

  it('shows the backend error and refreshes the model status when the model is down', async () => {
    mockFetch({
      '/api/assistant/chat': () => [503, { detail: 'Model server unreachable at http://x' }],
      '/api/assistant/status': () => [200, { reachable: false, installed: false, model: 'qwen3:8b' }],
    });
    await useAssistantStore.getState().send('hi');
    await new Promise(r => setTimeout(r, 0));
    const s = useAssistantStore.getState();
    expect(s.messages[1].error).toBe('Model server unreachable at http://x');
    expect(s.status?.reachable).toBe(false);
    expect(historyForRequest(s.messages)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  // The dashboard refreshes that follow get unusable bodies from this mock and fail: the card must still
  // say "done", or an operator could confirm an executed burn a second time.
  it('runs a confirmed burn through the manual-maneuver endpoint, once, and a failed refresh does not undo "done"', async () => {
    mockFetch({
      '/api/maneuver/manual': () => [200, { scheduled: true, status: 'SCHEDULED', burns_eci: [{ burn_id: 'MAN-1' }] }],
    });
    const store = useAssistantStore.getState();
    await Promise.all([store.confirmAction(burn), store.confirmAction(burn)]);
    const posts = calls.filter(c => c.url === '/api/maneuver/manual');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ satelliteId: 'SAT-A', burns: burn.params.burns, dry_run: false });
    expect(useAssistantStore.getState().actionStates['ACT-1']).toEqual({ state: 'done', message: 'Scheduled (MAN-1)' });
  });

  it('reports an engine rejection at confirm time as a failure', async () => {
    mockFetch({ '/api/maneuver/manual': () => [200, { scheduled: false, status: 'REJECTED: COOLDOWN_ACTIVE', burns_eci: [] }] });
    await useAssistantStore.getState().confirmAction(burn);
    expect(useAssistantStore.getState().actionStates['ACT-1']).toEqual({
      state: 'failed', message: 'Engine rejected the burn: REJECTED: COOLDOWN_ACTIVE' });
  });

  it('maps proposal, autopilot and screening actions to their endpoints', async () => {
    mockFetch({
      '/api/proposals/PROP-1/reject': () => [200, { proposal_id: 'PROP-1', status: 'REJECTED' }],
      '/api/autopilot': () => [200, { enabled: false, strategy: 'Auto', strategies: [] }],
      '/api/conjunctions/screen': () => [200, {}],
    });
    const base = { title: 't', valid: true, warnings: [], expires: null, preview: {} };
    const store = useAssistantStore.getState();
    await store.confirmAction({ ...base, action_id: 'A', kind: 'reject_proposal', params: { proposal_id: 'PROP-1', reason: 'fuel' } });
    await store.confirmAction({ ...base, action_id: 'B', kind: 'set_autopilot', params: { enabled: false } });
    await store.confirmAction({ ...base, action_id: 'C', kind: 'screen_now', params: {} });
    const mutating = calls.filter(c => c.method !== 'GET').map(c => [c.method, c.url, c.body]);
    expect(mutating).toEqual([
      ['POST', '/api/proposals/PROP-1/reject', { reason: 'fuel' }],
      ['PUT', '/api/autopilot', { enabled: false }],
      ['POST', '/api/conjunctions/screen', undefined],
    ]);
    const states = useAssistantStore.getState().actionStates;
    expect(states.A.message).toBe('Proposal PROP-1 is now REJECTED');
    expect([states.B.state, states.C.state]).toEqual(['done', 'done']);
  });

  it('dismisses and clears', () => {
    const store = useAssistantStore.getState();
    store.dismissAction('ACT-9');
    expect(useAssistantStore.getState().actionStates['ACT-9'].state).toBe('dismissed');
    useAssistantStore.setState({ messages: [{ role: 'user', content: 'x' }] });
    store.clear();
    expect(useAssistantStore.getState()).toMatchObject({ messages: [], actionStates: {} });
  });
});

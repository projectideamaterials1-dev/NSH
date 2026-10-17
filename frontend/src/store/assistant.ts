// src/store/assistant.ts
// Operator assistant (POST /api/assistant/chat): conversation, model status and the action cards
// the model proposes. The assistant never executes anything itself - a card runs only when the
// operator clicks Confirm, against the same endpoints the rest of the dashboard uses, so the
// backend validates, authorises and audits it exactly like a manual command.

import { create } from 'zustand';
import { apiJson } from '../api/http';
import useOrbitalStore from './useOrbitalStore';
import type { AutopilotInfo, ManualBurnInput, ManualPlanResult, Proposal } from './types';

export type ActionKind = 'manual_burn' | 'approve_proposal' | 'reject_proposal' | 'set_autopilot' | 'screen_now';

export interface ProposedAction {
  action_id: string;
  kind: ActionKind;
  title: string;
  params: Record<string, any>;
  preview: Record<string, any>;
  valid: boolean;
  warnings: string[];
  expires: string | null;
  /** Burns only: the ground contact the burn can be uplinked in (null for other kinds). */
  confirm_window?: ConfirmWindow | null;
}

export interface ConfirmWindow { from: string; until: string; stations: string[] }

export interface GroundingIssue {
  claim: string;
  line: string;
  scope: string[];
  problem: 'belongs_to_other_object' | 'not_in_tool_data';
  belongs_to?: string[];
}

export interface ToolCall { name: string; arguments: Record<string, unknown>; result?: unknown; error?: string }

export interface ChatReply {
  answer: string;
  thinking: string | null;
  model: string;
  stopped: 'answer' | 'step_limit';
  duration_s: number;
  tool_calls: ToolCall[];
  actions: ProposedAction[];
  grounding: { checked: number; issues: GroundingIssue[]; citations: Record<string, Record<string, any>> };
}

export interface AssistantStatus { provider: string; url: string; model: string; reachable: boolean; installed: boolean; loaded: boolean }

export type ActionState = { state: 'idle' | 'running' | 'done' | 'failed' | 'dismissed'; message?: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reply?: ChatReply;
  error?: string;
}

interface AssistantState {
  open: boolean;
  think: boolean;
  messages: ChatMessage[];
  pending: boolean;
  status: AssistantStatus | null;
  actionStates: Record<string, ActionState>;
  setOpen: (open: boolean) => void;
  setThink: (think: boolean) => void;
  clear: () => void;
  fetchStatus: () => Promise<void>;
  send: (text: string) => Promise<void>;
  confirmAction: (action: ProposedAction) => Promise<void>;
  dismissAction: (actionId: string) => void;
}

const HISTORY_LIMIT = 20;

/** The conversation as the backend wants it: text turns only, newest last, failed turns dropped. */
export function historyForRequest(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages
    .filter(m => !m.error && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-HISTORY_LIMIT);
}

/** An action whose burn time / proposal expiry has passed in simulation time can no longer be confirmed. */
export function actionExpired(action: ProposedAction, simTimestamp: string | null): boolean {
  if (!action.expires || !simTimestamp) return false;
  return Date.parse(action.expires) <= Date.parse(simTimestamp);
}

const hms = (iso: string) => `${iso.slice(11, 19)}Z`;

/** Why Confirm is unavailable right now, or null. A burn is uplinked when confirmed, so it can only be
 *  confirmed inside its ground-contact window (the engine re-checks line of sight either way). */
export function confirmBlocked(action: ProposedAction, simTimestamp: string | null): string | null {
  if (!action.valid) return 'The engine rejected this action';
  if (actionExpired(action, simTimestamp)) return 'Expired: its time has passed';
  const w = action.confirm_window;
  if (!w || !simTimestamp) return null;
  const now = Date.parse(simTimestamp);
  if (now < Date.parse(w.from)) return `Out of ground contact: Confirm opens at ${hms(w.from)}`;
  if (now > Date.parse(w.until)) return `Ground contact closed at ${hms(w.until)}: ask for a new proposal`;
  return null;
}

/** Re-reads the dashboard state after an action. Best effort: a failed refresh must never make an
 *  executed action look failed (the operator might then confirm it again and double a burn). */
function refreshDashboard(): void {
  const ops = useOrbitalStore.getState();
  for (const refresh of [ops.fetchOps, ops.fetchManeuvers, ops.fetchDecisions, ops.fetchAutopilot, () => ops.fetchSelectedInsights()]) {
    Promise.resolve().then(refresh).catch(() => { /* next poll catches up */ });
  }
}

/** Sends a confirmed action to the same endpoint the dashboard's own controls use. Success is judged
 *  on that command's response alone. Returns a one-line result. */
async function runCommand(action: ProposedAction): Promise<string> {
  const p = action.params;
  switch (action.kind) {
    case 'manual_burn': {
      const result = await apiJson<ManualPlanResult>('/api/maneuver/manual', {
        method: 'POST', body: JSON.stringify({ satelliteId: p.satellite_id, burns: p.burns as ManualBurnInput[], dry_run: false }),
      });
      if (!result.scheduled) throw new Error(`Engine rejected the burn: ${result.status}`);
      return `Scheduled (${result.burns_eci.map(b => b.burn_id).join(', ')})`;
    }
    case 'approve_proposal':
    case 'reject_proposal': {
      const approve = action.kind === 'approve_proposal';
      const proposal = await apiJson<Proposal>(
        `/api/proposals/${encodeURIComponent(p.proposal_id)}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST', body: JSON.stringify(approve ? {} : { reason: p.reason ?? null }) });
      return `Proposal ${proposal.proposal_id} is now ${proposal.status}`;
    }
    case 'set_autopilot': {
      const autopilot = await apiJson<AutopilotInfo>('/api/autopilot', { method: 'PUT', body: JSON.stringify(p) });
      useOrbitalStore.setState({ autopilot });
      return `Autopilot ${autopilot.enabled ? 'enabled' : 'disabled'} (strategy ${autopilot.strategy})`;
    }
    case 'screen_now':
      await apiJson('/api/conjunctions/screen', { method: 'POST' });
      return 'Screening complete';
    default:
      throw new Error(`Unknown action kind ${(action as ProposedAction).kind}`);
  }
}

export async function executeAction(action: ProposedAction): Promise<string> {
  const message = await runCommand(action);
  refreshDashboard();
  return message;
}

export const useAssistantStore = create<AssistantState>()((set, get) => ({
  open: false,
  think: false,
  messages: [],
  pending: false,
  status: null,
  actionStates: {},

  setOpen: (open) => {
    set({ open });
    if (open) get().fetchStatus();
  },
  setThink: (think) => set({ think }),
  clear: () => set({ messages: [], actionStates: {} }),

  fetchStatus: async () => {
    try {
      set({ status: await apiJson<AssistantStatus>('/api/assistant/status') });
    } catch {
      set({ status: null });
    }
  },

  send: async (text) => {
    const content = text.trim();
    if (!content || get().pending) return;
    const messages: ChatMessage[] = [...get().messages, { role: 'user', content }];
    set({ messages, pending: true });
    try {
      const reply = await apiJson<ChatReply>('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: historyForRequest(messages), think: get().think }),
      });
      set(s => ({ messages: [...s.messages, { role: 'assistant', content: reply.answer, reply }] }));
    } catch (e) {
      set(s => ({ messages: [...s.messages, { role: 'assistant', content: '', error: (e as Error).message }] }));
      get().fetchStatus();
    } finally {
      set({ pending: false });
    }
  },

  confirmAction: async (action) => {
    const current = get().actionStates[action.action_id]?.state;
    if (current === 'running' || current === 'done') return;
    set(s => ({ actionStates: { ...s.actionStates, [action.action_id]: { state: 'running' } } }));
    try {
      const message = await executeAction(action);
      set(s => ({ actionStates: { ...s.actionStates, [action.action_id]: { state: 'done', message } } }));
    } catch (e) {
      set(s => ({ actionStates: { ...s.actionStates, [action.action_id]: { state: 'failed', message: (e as Error).message } } }));
    }
  },

  dismissAction: (actionId) =>
    set(s => ({ actionStates: { ...s.actionStates, [actionId]: { state: 'dismissed' } } })),
}));

export default useAssistantStore;

// src/components/AssistantPanel.tsx
// Operator assistant drawer: chat with the local LLM, the engine records each answer cites, warnings
// for numbers the grounding check could not trace to the data, and action cards the operator
// confirms or dismisses. Confirming runs the action through the normal dashboard commands.

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Brain, CheckCircle2, ChevronRight, Loader2, MessageSquare, Send, ShieldCheck, Trash2, X, XCircle,
} from 'lucide-react';
import { parseMarkdown, type Inline } from '../lib/markdown';
import { COLORS } from '../lib/format';
import useOrbitalStore from '../store/useOrbitalStore';
import useAssistantStore, {
  confirmBlocked, type ChatMessage, type ChatReply, type ProposedAction,
} from '../store/assistant';
import { Button, usePresence } from './ui';

const SUGGESTIONS = [
  'Which open conjunction is the most dangerous right now, and why?',
  'Why did the autopilot make its most recent decision?',
  'Recommend an avoidance burn for the riskiest conjunction using the trade study.',
  'Are any proposals waiting for my approval?',
];

const fmtValue = (v: unknown): string => {
  if (typeof v === 'number') {
    if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6)) return v.toExponential(2);
    return String(Math.round(v * 10000) / 10000);
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

// ─── markdown ────────────────────────────────────────────────────────────────────────────────
const InlineText: React.FC<{ parts: Inline[] }> = ({ parts }) => (
  <>
    {parts.map((p, i) =>
      p.kind === 'bold' ? <strong key={i} className="font-semibold text-ink">{p.text}</strong>
        : p.kind === 'italic' ? <em key={i}>{p.text}</em>
          : p.kind === 'code' ? <code key={i} className="tabular text-[12px] bg-canvas border border-line rounded px-1">{p.text}</code>
            : <React.Fragment key={i}>{p.text}</React.Fragment>)}
  </>
);

const Markdown: React.FC<{ text: string }> = ({ text }) => (
  <div className="space-y-2 text-[13px] leading-relaxed text-ink/90">
    {parseMarkdown(text).map((b, i) => {
      if (b.kind === 'heading') return <h4 key={i} className="text-[13px] font-semibold text-ink pt-1"><InlineText parts={b.content} /></h4>;
      if (b.kind === 'list') {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag key={i} className={`pl-5 space-y-1 ${b.ordered ? 'list-decimal' : 'list-disc'} marker:text-faint`}>
            {b.items.map((item, j) => <li key={j}><InlineText parts={item} /></li>)}
          </Tag>
        );
      }
      return <p key={i}><InlineText parts={b.content} /></p>;
    })}
  </div>
);

// ─── evidence & grounding ──────────────────────────────────────────────────────────────────
const CITATION_FIELDS = ['satellite_id', 'object_id', 'tca', 'miss_distance_km', 'pc', 'risk', 'status',
  'outcome', 'kind', 'rationale', 'fuel_kg'];

const Citation: React.FC<{ id: string; record: Record<string, any> }> = ({ id, record }) => {
  const openConjunction = useOrbitalStore(s => s.openConjunction);
  const isCdm = 'cdm_id' in record && record.cdm_id === id;
  const fields = CITATION_FIELDS.filter(k => k in record && k !== 'cdm_id').slice(0, 6);
  return (
    <div className="rounded-md border border-line bg-canvas/60 px-2.5 py-2 text-[12px]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="tabular font-semibold text-ink">{id}</span>
        {isCdm && (
          <button className="text-accent hover:underline flex items-center gap-0.5" onClick={() => openConjunction(id)}>
            Open <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {fields.map(k => (
          <React.Fragment key={k}>
            <dt className="text-faint">{k.replace(/_/g, ' ')}</dt>
            <dd className="tabular text-muted truncate" title={fmtValue(record[k])}>{fmtValue(record[k])}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
};

const Grounding: React.FC<{ reply: ChatReply }> = ({ reply }) => {
  const { checked, issues, citations } = reply.grounding;
  const cited = Object.entries(citations);
  return (
    <div className="mt-2.5 space-y-2">
      {issues.length > 0 ? (
        <div className="rounded-md border px-2.5 py-2 text-[12px]" style={{ borderColor: `${COLORS.warn}66`, background: `${COLORS.warn}12` }}>
          <div className="flex items-center gap-1.5 font-medium mb-1" style={{ color: COLORS.warn }}>
            <AlertTriangle className="w-3.5 h-3.5" /> {issues.length} value{issues.length > 1 ? 's' : ''} not traceable to the engine data
          </div>
          <ul className="space-y-0.5 text-muted">
            {issues.map((i, k) => (
              <li key={k}>
                <span className="tabular text-ink">{i.claim}</span>{' — '}
                {i.problem === 'belongs_to_other_object'
                  ? <>belongs to <span className="tabular">{i.belongs_to?.join(', ')}</span>, not {i.scope.join(', ')}</>
                  : 'not in the data the assistant was given (computed or invented)'}
              </li>
            ))}
          </ul>
        </div>
      ) : checked > 0 ? (
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.ok }}>
          <ShieldCheck className="w-3.5 h-3.5" /> All {checked} numbers, times and dates match the engine data
        </div>
      ) : null}
      {cited.length > 0 && (
        <div>
          <div className="text-[11px] text-faint mb-1">Evidence (straight from the engine)</div>
          <div className="grid gap-1.5">{cited.map(([id, rec]) => <Citation key={id} id={id} record={rec} />)}</div>
        </div>
      )}
    </div>
  );
};

// ─── action cards ──────────────────────────────────────────────────────────────────────────
const ActionPreview: React.FC<{ action: ProposedAction }> = ({ action }) => {
  const p = action.preview;
  const rows: [string, unknown][] = action.kind === 'manual_burn'
    ? [
      ['Satellite', p.satellite_id],
      ['Burn time', p.burn_time],
      ['Δv (RTN, m/s)', Object.entries(p.dv_mps ?? {}).map(([k, v]) => `${k.toUpperCase()} ${v}`).join('  ')],
      ['Engine dry run', p.dry_run_status],
      ['Uplink window', p.uplink_window
        ? `${p.uplink_window.from.slice(11, 19)}–${p.uplink_window.until.slice(11, 19)}Z (${p.uplink_window.stations.join(', ')})`
        : 'none'],
      ['Fuel needed / available', `${fmtValue(p.fuel_needed_kg)} / ${fmtValue(p.available_fuel_kg)} kg`],
      ...(p.cdm_id ? [
        ['Avoids', p.cdm_id],
        ['Miss after burn', `${fmtValue(p.predicted_miss_km)} km`],
        ['Pc after burn', p.predicted_pc],
        ['Pc without burn', p.baseline_no_burn?.pc],
        ['Minutes before TCA', p.minutes_before_tca],
      ] as [string, unknown][] : []),
    ]
    : action.kind === 'set_autopilot'
      ? [['Current', p.current], ['New', p.new]]
      : action.kind === 'screen_now'
        ? [['Horizon', `${fmtValue(p.horizon_s / 3600)} h`], ['Warning sphere', `${p.warning_km} km`]]
        : [['Proposal', p.proposal_id], ['Satellite', p.satellite_id], ['Rationale', p.rationale], ['Fuel', `${fmtValue(p.fuel_kg)} kg`]];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-faint whitespace-nowrap">{k}</dt>
          <dd className="tabular text-ink/90 break-words">{fmtValue(v)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
};

const ActionCard: React.FC<{ action: ProposedAction }> = ({ action }) => {
  const st = useAssistantStore(s => s.actionStates[action.action_id]) ?? { state: 'idle' };
  const confirm = useAssistantStore(s => s.confirmAction);
  const dismiss = useAssistantStore(s => s.dismissAction);
  const simTime = useOrbitalStore(s => s.timestamp);
  const blocked = confirmBlocked(action, simTime);

  if (st.state === 'dismissed') {
    return <div className="text-[12px] text-faint italic">Dismissed: {action.title}</div>;
  }
  return (
    <div className="mt-2.5 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="text-[11px] uppercase tracking-wide text-accent mb-1">Proposed action · needs your confirmation</div>
      <div className="text-[13px] font-medium text-ink mb-2">{action.title}</div>
      <ActionPreview action={action} />
      {action.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {action.warnings.map((w, i) => (
            <li key={i} className="flex gap-1.5 text-[12px]" style={{ color: COLORS.warn }}>
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        {st.state === 'done' ? (
          <span className="flex items-center gap-1.5 text-[12px]" style={{ color: COLORS.ok }}>
            <CheckCircle2 className="w-4 h-4" /> {st.message}
          </span>
        ) : (
          <>
            <Button variant="primary" disabled={Boolean(blocked) || st.state === 'running'} onClick={() => confirm(action)}
              title={blocked ?? 'Execute this action now'}
              icon={st.state === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}>
              {st.state === 'running' ? 'Executing…' : 'Confirm'}
            </Button>
            <Button variant="ghost" disabled={st.state === 'running'} onClick={() => dismiss(action.action_id)}>Dismiss</Button>
            {blocked && <span className="text-[12px] text-faint">{blocked}</span>}
          </>
        )}
      </div>
      {st.state === 'failed' && (
        <div className="mt-2 flex gap-1.5 text-[12px]" style={{ color: COLORS.crit }}>
          <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {st.message}
        </div>
      )}
    </div>
  );
};

// ─── messages ──────────────────────────────────────────────────────────────────────────────
const AssistantMessage: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const { reply } = message;
  if (message.error || !reply) {
    return (
      <div className="rounded-md border px-3 py-2 text-[13px]" style={{ borderColor: `${COLORS.crit}66`, color: COLORS.crit }}>
        {message.error ?? 'No reply'}
      </div>
    );
  }
  return (
    <div>
      {reply.answer ? <Markdown text={reply.answer} /> : <p className="text-[13px] text-muted italic">The model gave no answer.</p>}
      {reply.actions.map(a => <ActionCard key={a.action_id} action={a} />)}
      <Grounding reply={reply} />
      <details className="mt-2 text-[11px] text-faint">
        <summary className="cursor-pointer select-none hover:text-muted">
          {reply.model} · {reply.duration_s.toFixed(1)} s · {reply.tool_calls.length} tool call{reply.tool_calls.length === 1 ? '' : 's'}
          {reply.stopped === 'step_limit' ? ' · stopped at tool limit' : ''}
        </summary>
        <div className="mt-1.5 space-y-1.5">
          {reply.tool_calls.map((c, i) => (
            <div key={i}>
              <div className="tabular text-muted">{c.name}({JSON.stringify(c.arguments)}){c.error ? ` → error: ${c.error}` : ''}</div>
              {c.result !== undefined && (
                <pre className="mt-0.5 max-h-40 overflow-auto bg-canvas border border-line rounded p-1.5 text-[10.5px] whitespace-pre-wrap break-all">
                  {JSON.stringify(c.result, null, 1).slice(0, 4000)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
};

const PendingIndicator: React.FC = () => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <Loader2 className="w-4 h-4 animate-spin text-accent" /> Checking the engine data… {seconds}s
    </div>
  );
};

const StatusPill: React.FC = () => {
  const status = useAssistantStore(s => s.status);
  const ok = status?.reachable && status.installed;
  const color = ok ? COLORS.ok : COLORS.crit;
  const label = !status ? 'unknown' : !status.reachable ? 'model offline' : !status.installed ? 'model missing' : status.model;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted tabular" title={status?.url}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} /> {label}
    </span>
  );
};

// ─── panel ─────────────────────────────────────────────────────────────────────────────────
export const AssistantPanel: React.FC = () => {
  const { open, think, messages, pending, status } = useAssistantStore();
  const { setOpen, setThink, clear, send } = useAssistantStore.getState();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const { mounted, closing } = usePresence(open, 180);
  if (!mounted) return null;

  const submit = (text = draft) => {
    if (!text.trim() || pending) return;
    send(text);
    setDraft('');
  };

  return (
    <aside className={`fixed right-0 top-14 bottom-0 z-40 w-full sm:w-[460px] bg-panel border-l border-line shadow-2xl flex flex-col will-change-transform ${closing ? 'animate-drawer-out pointer-events-none' : 'animate-drawer-in'}`}
      aria-label="Operator assistant">
      <header className="flex items-center gap-2 px-4 h-11 border-b border-line flex-shrink-0">
        <MessageSquare className="w-4 h-4 text-accent" />
        <h2 className="text-[14px] font-semibold text-ink">Assistant</h2>
        <StatusPill />
        <div className="flex-1" />
        <button role="switch" aria-checked={think} onClick={() => setThink(!think)}
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border text-[12px] ${
            think ? 'border-accent/60 text-accent bg-accent/10' : 'border-line text-muted hover:text-ink'}`}
          title="Let the model reason before answering: better plans, slower replies">
          <Brain className="w-3.5 h-3.5" /> Think harder
        </button>
        <Button variant="ghost" onClick={clear} disabled={pending || !messages.length} aria-label="Clear conversation"
          title="Clear conversation" icon={<Trash2 className="w-4 h-4" />} />
        <Button variant="ghost" onClick={() => setOpen(false)} aria-label="Close assistant" icon={<X className="w-4 h-4" />} />
      </header>

      {status && (!status.reachable || !status.installed) && (
        <div className="px-4 py-2 text-[12px] border-b border-line" style={{ background: `${COLORS.crit}12`, color: COLORS.crit }}>
          {!status.reachable
            ? <>The local model server is not running. Start it with <code className="tabular">.\scripts\ollama.ps1</code></>
            : <>Model {status.model} is not installed: <code className="tabular">.\scripts\ollama.ps1 -Pull {status.model}</code></>}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="pt-4">
            <p className="text-[13px] text-muted mb-3">
              Ask about conjunctions, maneuvers, the autopilot's decisions or the fleet. Answers come from the engine's
              data, every number is checked against it, and any action needs your confirmation.
            </p>
            <div className="grid gap-1.5">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => submit(s)} disabled={pending}
                  className="text-left text-[13px] text-ink/90 rounded-md border border-line bg-raised hover:border-line-strong px-3 py-2">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => m.role === 'user' ? (
          <div key={i} className="flex justify-end animate-content-in">
            <div className="max-w-[85%] rounded-lg bg-accent/15 border border-accent/30 px-3 py-2 text-[13px] text-ink whitespace-pre-wrap">
              {m.content}
            </div>
          </div>
        ) : <div key={i} className="animate-content-in"><AssistantMessage message={m} /></div>)}
        {pending && <div className="animate-fade-in"><PendingIndicator /></div>}
      </div>

      <form className="border-t border-line p-3 flex gap-2 flex-shrink-0" onSubmit={e => { e.preventDefault(); submit(); }}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} maxLength={8000}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Ask the assistant… (Enter to send, Shift+Enter for a new line)"
          aria-label="Message the assistant"
          className="flex-1 resize-none rounded-md bg-raised border border-line focus:border-accent outline-none px-3 py-2 text-[13px] text-ink placeholder:text-faint" />
        <Button type="submit" variant="primary" disabled={pending || !draft.trim()} aria-label="Send" icon={<Send className="w-4 h-4" />} />
      </form>
    </aside>
  );
};

export default AssistantPanel;

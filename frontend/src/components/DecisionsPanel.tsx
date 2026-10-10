// src/components/DecisionsPanel.tsx
// Human-in-the-loop and explainability: maneuver proposals awaiting approval (APPROVAL mode) and the
// autopilot's decision log, each with its plain-language rationale and the options it considered.

import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Scale, X } from 'lucide-react';
import useOrbitalStore, { selectPendingProposals } from '../store/useOrbitalStore';
import type { Decision, DecisionCandidate, Proposal } from '../store/useOrbitalStore';
import { COLORS, formatDuration, formatKm, formatPc, formatUtcTime, secondsUntil } from '../lib/format';
import { Button, EmptyState } from './ui';

const OUTCOME_META: Record<Decision['outcome'], { label: string; color: string }> = {
  SCHEDULED: { label: 'Scheduled', color: COLORS.ok },
  APPROVED: { label: 'Approved', color: COLORS.ok },
  PROPOSED: { label: 'Awaiting approval', color: COLORS.warn },
  REJECTED: { label: 'Failed validation', color: COLORS.crit },
  FAILED: { label: 'Failed at approval', color: COLORS.crit },
  EXPIRED: { label: 'Expired', color: COLORS.crit },
  REJECTED_BY_OPERATOR: { label: 'Rejected by operator', color: '#9aa8b6' },
};

const KIND_LABEL = { EVASION: 'Collision avoidance', STATION_KEEPING: 'Station keeping', EOL: 'End of life' } as const;

const ProposalCard: React.FC<{ p: Proposal }> = ({ p }) => {
  const answer = useOrbitalStore(s => s.answerProposal);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = secondsUntil(p.expires_at, timestamp);

  const respond = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    setError(null);
    try {
      await answer(p.proposal_id, approve);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="mx-3 my-2 rounded-lg border border-warn/50 bg-warn/5 p-3" aria-label={`Proposal ${p.proposal_id}`}>
      <header className="flex items-center gap-2 text-[13px]">
        <button className="tabular text-ink font-medium hover:text-accent" onClick={() => selectSatellite(p.satellite_id)}>
          {p.satellite_id}
        </button>
        <span className="text-muted">{KIND_LABEL[p.kind]}</span>
        <span className={`ml-auto tabular text-[12px] ${left < 300 ? 'text-crit' : 'text-warn'}`}
          title={`Then: ${p.timeout_action === 'EXECUTE' ? 'executes automatically' : 'discarded and re-planned'}`}>
          {left > 0 ? `${formatDuration(left)} left` : 'timing out'}
        </span>
      </header>
      <p className="text-[12px] text-ink leading-relaxed mt-2">{p.rationale}</p>
      <p className="text-[12px] text-muted mt-1.5 tabular">
        {p.burns.length} burn(s) · {p.burns.reduce((a, b) => a + b.delta_v_mps, 0).toFixed(2)} m/s · {p.fuel_kg.toFixed(3)} kg ·
        burns are re-targeted from the state at approval
      </p>
      {error && <p className="text-[12px] text-crit mt-1">{error}</p>}
      <div className="flex gap-2 mt-3">
        <Button variant="primary" onClick={() => respond(true)} disabled={!!busy} icon={<Check className="w-4 h-4" />}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button onClick={() => respond(false)} disabled={!!busy} icon={<X className="w-4 h-4" />}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </article>
  );
};

const CandidateRow: React.FC<{ c: DecisionCandidate }> = ({ c }) => {
  const prim = c.verification?.primary[0];
  const secondary = c.verification?.secondary.filter(r => r.needs_action) ?? [];
  return (
    <li className="flex items-start gap-2 py-1">
      <span className="mt-1 w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: c.clean === false ? COLORS.crit : c.clean ? COLORS.ok : '#9aa8b6' }} aria-hidden />
      <span className="min-w-0">
        <span className={c.chosen ? 'text-ink font-medium' : 'text-muted'}>{c.label}{c.chosen ? ' (chosen)' : ''}</span>
        <span className="block text-faint tabular">
          {c.total_dv_mps.toFixed(2)} m/s · {c.fuel_kg.toFixed(3)} kg
          {prim ? ` · primary ${formatKm(prim.miss_distance_km)}, Pc ${formatPc(prim.pc)}` : c.verification ? ' · primary cleared' : ''}
          {secondary.length ? ` · ${secondary.length} new conjunction(s): ${secondary.map(r => `${r.object_id} ${formatKm(r.miss_distance_km)}`).join(', ')}` : ''}
          {c.clean === false ? ' · not clean' : c.clean ? ' · clean' : ''}
        </span>
      </span>
    </li>
  );
};

const DecisionRow: React.FC<{ d: Decision }> = ({ d }) => {
  const [open, setOpen] = useState(false);
  const meta = OUTCOME_META[d.outcome];
  const hasDetail = (d.candidates?.length ?? 0) > 0 || (d.burns?.length ?? 0) > 0;
  return (
    <li className="border-b border-line/60 px-4 py-2.5">
      <button className="w-full text-left flex items-center gap-2 text-[13px]" onClick={() => setOpen(o => !o)}
        aria-expanded={open} disabled={!hasDetail}>
        {hasDetail ? (open ? <ChevronDown className="w-3.5 h-3.5 text-faint" /> : <ChevronRight className="w-3.5 h-3.5 text-faint" />)
          : <span className="w-3.5" />}
        <span className="tabular text-ink">{d.satellite_id}</span>
        <span className="text-muted truncate">{KIND_LABEL[d.kind]}</span>
        <span className="ml-auto text-[12px] whitespace-nowrap flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: meta.color }} aria-hidden />
          <span className="text-muted">{meta.label}</span>
        </span>
      </button>
      <p className="text-[12px] text-ink/90 leading-relaxed mt-1.5 pl-5">{d.rationale}</p>
      <p className="text-[11px] text-faint mt-1 pl-5 tabular">
        {d.sim_time ? formatUtcTime(d.sim_time) : ''} · {d.actor}{d.reason ? ` · ${d.reason.replace(/_/g, ' ').toLowerCase()}` : ''}
      </p>
      {open && (
        <div className="pl-5 mt-2 text-[12px]">
          {d.candidates && d.candidates.length > 0 && (
            <>
              <h5 className="text-faint mb-1">Options considered</h5>
              <ul>{d.candidates.map(c => <CandidateRow key={c.label} c={c} />)}</ul>
            </>
          )}
          {d.burns && d.burns.length > 0 && (
            <>
              <h5 className="text-faint mt-2 mb-1">Burns</h5>
              <ul className="tabular text-muted">
                {d.burns.map(b => <li key={b.burn_id}>{formatUtcTime(b.burn_time)} · {b.maneuver_type.replace(/_/g, ' ').toLowerCase()} · {b.delta_v_mps.toFixed(2)} m/s</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
};

export const DecisionsPanel: React.FC = () => {
  const decisions = useOrbitalStore(s => s.decisions);
  const pending = useOrbitalStore(selectPendingProposals);
  const fetchDecisions = useOrbitalStore(s => s.fetchDecisions);
  const mode = useOrbitalStore(s => s.config?.autopilotMode ?? 'AUTONOMOUS');

  useEffect(() => {
    fetchDecisions();
    const id = setInterval(fetchDecisions, 4000);
    return () => clearInterval(id);
  }, [fetchDecisions]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-4 py-2 text-[12px] text-muted border-b border-line/60">
        Command authority: <b className={mode === 'APPROVAL' ? 'text-warn' : 'text-ink'}>
          {mode === 'APPROVAL' ? 'operator approval required' : 'autonomous'}</b>
        <span className="text-faint"> · change in Settings</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {pending.length > 0 && (
          <section aria-label="Proposals awaiting approval">
            <h3 className="section-title px-4 pt-3">Awaiting approval ({pending.length})</h3>
            {pending.map(p => <ProposalCard key={p.proposal_id} p={p} />)}
          </section>
        )}
        {decisions.length === 0 ? (
          <EmptyState icon={<Scale className="w-6 h-6" />} title="No autopilot decisions yet">
            Every burn the autopilot plans, proposes or rejects is logged here with its reasoning.
          </EmptyState>
        ) : (
          <section aria-label="Decision log">
            <h3 className="section-title px-4 pt-3 pb-1">Decision log</h3>
            <ul>{decisions.map(d => <DecisionRow key={d.decision_id} d={d} />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
};

export default DecisionsPanel;

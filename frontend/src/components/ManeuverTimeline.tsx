// src/components/ManeuverTimeline.tsx
// Gantt view of burns and their thermal cooldowns, with conflict detection, maneuver types and cancellation.

import React, { useMemo, useState } from 'react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { ManeuverEvent } from '../store/useOrbitalStore';
import { COLORS, formatDuration, formatUtcTime, maneuverMeta, secondsUntil } from '../lib/format';
import { Button, EmptyState, Modal } from './ui';

const ROW_H = 36;
const LABEL_W = 96;
const AXIS_H = 28;
const CHART_W = 900;

interface Row { satelliteId: string; events: (ManeuverEvent & { conflict: boolean })[] }

export const ManeuverTimeline: React.FC<{ satelliteId: string | null; onClose: () => void }> = ({ satelliteId, onClose }) => {
  const maneuvers = useOrbitalStore(s => s.maneuvers);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const cancelManeuver = useOrbitalStore(s => s.cancelManeuver);
  const [scope, setScope] = useState<'selected' | 'all'>(satelliteId ? 'selected' : 'all');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancel = async (burnId: string) => {
    setCancelling(burnId);
    setCancelError(null);
    try {
      await cancelManeuver(burnId);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancelling(null);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const bySat = new Map<string, ManeuverEvent[]>();
    for (const m of maneuvers) {
      if (scope === 'selected' && m.satellite_id !== satelliteId) continue;
      if (!bySat.has(m.satellite_id)) bySat.set(m.satellite_id, []);
      bySat.get(m.satellite_id)!.push(m);
    }
    return [...bySat.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([id, events]) => {
        let coolEnd = -Infinity;
        const sorted = events.slice().sort((a, b) => a.burnTime.localeCompare(b.burnTime)).map(ev => {
          const start = Date.parse(ev.burnTime);
          const conflict = start < coolEnd;
          coolEnd = Math.max(coolEnd, Date.parse(ev.cooldown_end));
          return { ...ev, conflict };
        });
        return { satelliteId: id, events: sorted };
      });
  }, [maneuvers, scope, satelliteId]);

  const nowMs = timestamp ? Date.parse(timestamp) : Date.now();
  const range = useMemo(() => {
    const times = rows.flatMap(r => r.events.flatMap(e => [Date.parse(e.burnTime), Date.parse(e.cooldown_end)]));
    const min = Math.min(nowMs, ...times) - 5 * 60_000;
    const max = Math.max(nowMs, ...times) + 5 * 60_000;
    return { min, max, span: Math.max(max - min, 60_000) };
  }, [rows, nowMs]);

  const x = (t: number) => LABEL_W + ((t - range.min) / range.span) * (CHART_W - LABEL_W - 12);
  const ticks = Array.from({ length: 6 }, (_, i) => range.min + (i / 5) * range.span);
  const height = AXIS_H + rows.length * ROW_H + 8;
  const conflicts = rows.reduce((n, r) => n + r.events.filter(e => e.conflict).length, 0);
  const queued = rows.flatMap(r => r.events.filter(e => e.status === 'pending')).sort((a, b) => a.burnTime.localeCompare(b.burnTime));

  return (
    <Modal
      title="Maneuver timeline"
      subtitle={`Burns and thermal cooldowns · now ${formatUtcTime(nowMs)} UTC`}
      onClose={onClose}
      width={980}
    >
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex rounded-md border border-line overflow-hidden text-[13px]">
          {satelliteId && (
            <button onClick={() => setScope('selected')} className={`px-3 h-8 ${scope === 'selected' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
              {satelliteId}
            </button>
          )}
          <button onClick={() => setScope('all')} className={`px-3 h-8 ${scope === 'all' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
            All satellites
          </button>
        </div>
        <div className="flex items-center gap-4 text-[12px] text-muted">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: COLORS.accent }} />Executed</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm border-2" style={{ borderColor: COLORS.accent }} />Queued</span>
          <span className="flex items-center gap-1.5"><span className="w-5 h-3 rounded-sm" style={{ background: 'rgba(227,160,8,0.3)' }} />Cooldown</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: COLORS.crit }} />Conflict</span>
          <span className={conflicts ? 'text-crit font-medium' : 'text-ok'}>{conflicts ? `${conflicts} conflict(s)` : 'No conflicts'}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[12px] text-muted">
        {['PHASING_PROGRADE', 'PHASING_RETROGRADE', 'RADIAL_SHUNT', 'RECOVERY', 'EOL_GRAVEYARD', 'MANUAL', 'EXTERNAL'].map(type => (
          <span key={type} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: maneuverMeta(type).color }} />{maneuverMeta(type).label}
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="border border-line rounded-lg">
          <EmptyState title="No maneuvers">
            {scope === 'selected' ? `${satelliteId} has no queued or executed burns.` : 'No burns have been scheduled yet.'}
          </EmptyState>
        </div>
      ) : (
        <div className="border border-line rounded-lg bg-canvas overflow-x-auto">
          <svg viewBox={`0 0 ${CHART_W} ${height}`} width="100%" style={{ minWidth: 720, display: 'block' }} role="img" aria-label="Maneuver Gantt chart">
            {ticks.map((t, i) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={AXIS_H - 6} y2={height} stroke="#1f2833" />
                <text
                  x={x(t)} y={16} fontSize="11" fill="#9aa8b6" fontFamily="JetBrains Mono, monospace"
                  textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
                >{formatUtcTime(t, false)}</text>
              </g>
            ))}
            {rows.map((row, i) => {
              const y = AXIS_H + i * ROW_H;
              return (
                <g key={row.satelliteId}>
                  {i % 2 === 0 && <rect x={0} y={y} width={CHART_W} height={ROW_H} fill="#0e131a" />}
                  <text x={12} y={y + ROW_H / 2 + 4} fontSize="12" fill="#e6edf3" fontFamily="JetBrains Mono, monospace">{row.satelliteId}</text>
                  {row.events.map(ev => {
                    const start = x(Date.parse(ev.burnTime));
                    const coolEnd = x(Date.parse(ev.cooldown_end));
                    const color = ev.conflict ? COLORS.crit : maneuverMeta(ev.maneuver_type).color;
                    const executed = ev.status === 'executed';
                    return (
                      <g key={ev.burn_id}>
                        <title>{`${ev.burn_id} · ${maneuverMeta(ev.maneuver_type).label}\n${formatUtcTime(ev.burnTime)} UTC · Δv ${ev.delta_v_magnitude.toFixed(2)} m/s\n${executed ? 'Executed' : 'Queued'}${ev.conflict ? ' · overlaps previous cooldown' : ''}`}</title>
                        <rect x={start} y={y + 10} width={Math.max(coolEnd - start, 2)} height={ROW_H - 20} rx={3} fill="rgba(227,160,8,0.22)" />
                        <rect
                          x={start - 3} y={y + 6} width={6} height={ROW_H - 12} rx={2}
                          fill={executed ? color : '#07090d'} stroke={color} strokeWidth={2}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {nowMs >= range.min && nowMs <= range.max && (
              <g>
                <line x1={x(nowMs)} x2={x(nowMs)} y1={AXIS_H - 6} y2={height} stroke="#e6edf3" strokeWidth={1.5} strokeDasharray="4 3" />
                <rect x={x(nowMs) - 18} y={AXIS_H - 8} width={36} height={14} rx={3} fill="#e6edf3" />
                <text x={x(nowMs)} y={AXIS_H + 2} fontSize="10" fill="#07090d" textAnchor="middle" fontWeight="700">NOW</text>
              </g>
            )}
          </svg>
        </div>
      )}

      {queued.length > 0 && (
        <div className="mt-5">
          <h4 className="section-title mb-2">Queued burns ({queued.length})</h4>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="font-medium py-2">Satellite</th>
                <th className="font-medium py-2">Type</th>
                <th className="font-medium py-2">Time (UTC)</th>
                <th className="font-medium py-2 text-right">Δv</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="tabular">
              {queued.map(ev => {
                const meta = maneuverMeta(ev.maneuver_type);
                return (
                  <tr key={ev.burn_id} className="border-b border-line/60">
                    <td className="py-2 text-ink">{ev.satellite_id}</td>
                    <td className="py-2"><span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />{meta.label}</span></td>
                    <td className="py-2 text-muted">{formatUtcTime(ev.burnTime)} · in {formatDuration(secondsUntil(ev.burnTime, timestamp))}</td>
                    <td className="py-2 text-right">{ev.delta_v_magnitude.toFixed(2)} m/s</td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" onClick={() => cancel(ev.burn_id)} disabled={cancelling === ev.burn_id} className="h-7 text-crit">
                        {cancelling === ev.burn_id ? 'Cancelling…' : 'Cancel'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {cancelError && <p className="text-[13px] text-crit mt-2">{cancelError}</p>}
        </div>
      )}
    </Modal>
  );
};

export default ManeuverTimeline;

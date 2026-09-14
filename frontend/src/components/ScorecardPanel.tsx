// src/components/ScorecardPanel.tsx
// Mission scorecard: safety, efficiency and station-keeping metrics from /api/metrics.

import React from 'react';
import { Gauge } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import { COLORS, formatDuration, riskMeta } from '../lib/format';
import { EmptyState } from './ui';

const Tile: React.FC<{ label: string; value: string; sub?: string; tone?: string }> = ({ label, value, sub, tone }) => (
  <div className="bg-raised border border-line rounded-lg px-3 py-2.5">
    <div className="text-[11px] text-muted">{label}</div>
    <div className="tabular text-[19px] font-semibold mt-0.5 leading-tight" style={{ color: tone }}>{value}</div>
    {sub && <div className="text-[11px] text-faint mt-0.5">{sub}</div>}
  </div>
);

export const ScorecardPanel: React.FC = () => {
  const m = useOrbitalStore(s => s.metrics);
  if (!m || m.satellites === 0) {
    return <EmptyState icon={<Gauge className="w-6 h-6" />} title="No mission data yet">Metrics accumulate once telemetry arrives.</EmptyState>;
  }

  const sk = m.station_keeping;
  const threatsHandled = m.collisions_avoided + m.collisions_detected;
  const safety = threatsHandled ? (100 * m.collisions_avoided) / threatsHandled : 100;
  const byStatus = m.conjunctions.by_status;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-5">
      <section>
        <h3 className="section-title mb-2">Safety</h3>
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Collisions avoided" value={String(m.collisions_avoided)} tone={m.collisions_avoided ? COLORS.ok : undefined} />
          <Tile label="Collisions" value={String(m.collisions_detected)} tone={m.collisions_detected ? COLORS.crit : COLORS.ok} />
          <Tile label="Safety rate" value={`${safety.toFixed(0)}%`} sub="avoided ÷ (avoided + collisions)" tone={safety < 100 ? COLORS.warn : COLORS.ok} />
          <Tile label="Avoidance burns" value={String(m.avoidance_burns_executed)} sub={`${m.burns_executed} burns total · ${m.burns_rejected} rejected`} />
        </div>
      </section>

      <section>
        <h3 className="section-title mb-2">Efficiency</h3>
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Propellant used" value={`${m.fuel_used_kg.toFixed(3)} kg`} />
          <Tile label="Fuel per avoidance" value={m.fuel_per_avoidance_kg === null ? '—' : `${m.fuel_per_avoidance_kg.toFixed(3)} kg`} />
          <Tile label="Fleet propellant" value={`${m.fleet_fuel_remaining_kg.toFixed(1)} kg`} sub={`${m.satellites} satellites`} />
          <Tile label="Retired (EOL)" value={String(m.eol_satellites)} tone={m.eol_satellites ? COLORS.warn : undefined} />
        </div>
      </section>

      <section>
        <h3 className="section-title mb-2">Station keeping</h3>
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Uptime (time-weighted)" value={`${sk.time_weighted_uptime_percentage.toFixed(2)}%`}
            tone={sk.time_weighted_uptime_percentage < 95 ? COLORS.warn : COLORS.ok} />
          <Tile label="In box now" value={`${sk.uptime_percentage.toFixed(1)}%`}
            sub={`${sk.satellites_outside_box} outside the ${sk.box_radius_km ?? 10} km box`} />
        </div>
      </section>

      <section>
        <h3 className="section-title mb-2">Conjunctions</h3>
        <div className="bg-raised border border-line rounded-lg divide-y divide-line text-[13px]">
          {(['CRITICAL', 'WARNING', 'WATCH'] as const).map(r => (
            <div key={r} className="flex justify-between px-3 py-2">
              <span style={{ color: riskMeta(r).color }}>{riskMeta(r).label} open</span>
              <span className="tabular text-ink">{m.conjunctions.open_by_risk[r] ?? 0}</span>
            </div>
          ))}
          {Object.entries(byStatus).map(([status, n]) => (
            <div key={status} className="flex justify-between px-3 py-2 text-muted">
              <span>{status.charAt(0) + status.slice(1).toLowerCase()}</span>
              <span className="tabular">{n}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-faint mt-2 tabular">
          Simulated {formatDuration(m.sim_seconds_elapsed)}
          {m.last_screen ? ` · screening ${formatDuration(m.last_screen.horizon_s)} ahead with a ${m.last_screen.warning_km} km radius` : ''}
        </p>
      </section>
    </div>
  );
};

export default ScorecardPanel;

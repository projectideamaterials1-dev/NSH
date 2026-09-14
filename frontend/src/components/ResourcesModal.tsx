// src/components/ResourcesModal.tsx
// Propellant and Δv analysis for one satellite, built from executed burn records.

import React, { useMemo } from 'react';
import {
  Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import useOrbitalStore from '../store/useOrbitalStore';
import { COLORS, FUEL_INITIAL_KG, fuelColor, formatUtcTime } from '../lib/format';
import { EmptyState, Modal } from './ui';

const Stat: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <div className="bg-raised border border-line rounded-lg px-4 py-3">
    <div className="text-[12px] text-muted">{label}</div>
    <div className="tabular text-xl font-semibold mt-1" style={{ color: tone }}>{value}</div>
  </div>
);

export const ResourcesModal: React.FC<{ satelliteId: string; onClose: () => void }> = ({ satelliteId, onClose }) => {
  const maneuvers = useOrbitalStore(s => s.maneuvers);
  const fuelNow = useOrbitalStore(s => {
    const i = s.satellites?.ids.indexOf(satelliteId) ?? -1;
    return i >= 0 && s.satellites ? s.satellites.fuels[i] : null;
  });

  const burns = useMemo(
    () => maneuvers
      .filter(m => m.satellite_id === satelliteId && m.status === 'executed')
      .sort((a, b) => a.burnTime.localeCompare(b.burnTime)),
    [maneuvers, satelliteId]
  );

  const series = useMemo(() => {
    let fuel = FUEL_INITIAL_KG;
    let dv = 0;
    const points = [{ label: 'Start', fuel, dv: 0, burnDv: 0 }];
    for (const b of burns) {
      fuel -= b.fuel_consumed_kg ?? 0;
      dv += b.delta_v_magnitude;
      points.push({ label: formatUtcTime(b.burnTime), fuel: +fuel.toFixed(3), dv: +dv.toFixed(3), burnDv: +b.delta_v_magnitude.toFixed(3) });
    }
    return points;
  }, [burns]);

  const used = burns.reduce((s, b) => s + (b.fuel_consumed_kg ?? 0), 0);
  const totalDv = burns.reduce((s, b) => s + b.delta_v_magnitude, 0);
  const remaining = fuelNow ?? FUEL_INITIAL_KG - used;

  return (
    <Modal title={`${satelliteId} · Fuel & Δv`} subtitle="Tsiolkovsky propellant use per executed burn (Isp 300 s, dry mass 500 kg)" onClose={onClose} width={820}>
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Propellant remaining" value={`${remaining.toFixed(2)} kg`} tone={fuelColor(remaining)} />
        <Stat label="Propellant used" value={`${used.toFixed(3)} kg`} />
        <Stat label="Total Δv" value={`${totalDv.toFixed(2)} m/s`} />
        <Stat label="Efficiency" value={totalDv > 0 ? `${(totalDv / Math.max(used, 1e-6)).toFixed(1)} m/s·kg⁻¹` : '—'} />
      </div>

      <h4 className="section-title mt-6 mb-2">Propellant and cumulative Δv</h4>
      {burns.length === 0 ? (
        <div className="border border-line rounded-lg"><EmptyState title="No executed burns yet">The chart fills in as maneuvers execute.</EmptyState></div>
      ) : (
        <div className="h-64 border border-line rounded-lg p-3 bg-canvas">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#1f2833" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#9aa8b6', fontSize: 11 }} stroke="#33404f" />
              <YAxis yAxisId="fuel" domain={['auto', FUEL_INITIAL_KG]} tick={{ fill: '#9aa8b6', fontSize: 11 }} stroke="#33404f" width={44} unit=" kg" />
              <YAxis yAxisId="dv" orientation="right" tick={{ fill: '#9aa8b6', fontSize: 11 }} stroke="#33404f" width={52} unit=" m/s" />
              <Tooltip
                contentStyle={{ background: '#0e131a', border: '1px solid #33404f', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#e6edf3' }}
              />
              <Bar yAxisId="dv" dataKey="burnDv" name="Burn Δv (m/s)" fill={COLORS.warn} fillOpacity={0.35} barSize={6} />
              <Line yAxisId="fuel" type="stepAfter" dataKey="fuel" name="Propellant (kg)" stroke={COLORS.ok} strokeWidth={2} dot={false} />
              <Line yAxisId="dv" type="stepAfter" dataKey="dv" name="Cumulative Δv (m/s)" stroke={COLORS.accent} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {burns.length > 0 && (
        <>
          <h4 className="section-title mt-6 mb-2">Burn log</h4>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="font-medium py-2">Burn</th>
                <th className="font-medium py-2">Time (UTC)</th>
                <th className="font-medium py-2 text-right">Δv</th>
                <th className="font-medium py-2 text-right">Propellant</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {burns.slice().reverse().map(b => (
                <tr key={b.burn_id} className="border-b border-line/60">
                  <td className="py-2 text-ink">{b.burn_id}</td>
                  <td className="py-2 text-muted">{formatUtcTime(b.burnTime)}</td>
                  <td className="py-2 text-right">{b.delta_v_magnitude.toFixed(2)} m/s</td>
                  <td className="py-2 text-right">{(b.fuel_consumed_kg ?? 0).toFixed(3)} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
};

export default ResourcesModal;

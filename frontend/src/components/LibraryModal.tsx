// src/components/LibraryModal.tsx
// Library: present-day space stations (linked to the live satellites when they are in the fleet) and the
// Solar System's bodies with their major moons and the spacecraft working there. Data: lib/library.ts.

import React, { useMemo, useState } from 'react';
import { Crosshair } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import { AS_OF, SOLAR_SYSTEM, SPACE_STATIONS, type Body } from '../lib/library';
import { Modal } from './ui';

type Tab = 'stations' | 'solar';

const num = (v: number, digits = 0) => v.toLocaleString(undefined, { maximumFractionDigits: digits });

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="bg-raised border border-line rounded-md px-3 py-2">
    <div className="text-[11px] text-muted">{label}</div>
    <div className="text-[13px] text-ink tabular">{value}</div>
  </div>
);

const StationsTab: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const ids = useOrbitalStore(s => s.satellites?.ids);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const inFleet = useMemo(() => new Set(ids ?? []), [ids]);
  return (
    <div className="space-y-4">
      {SPACE_STATIONS.map(st => {
        const live = st.catalogIds.find(id => inFleet.has(id));
        return (
          <article key={st.name} className="border border-line rounded-lg p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-[15px] font-semibold text-ink">{st.name}</h4>
                <p className="text-[12px] text-muted">{st.operators}</p>
              </div>
              {live ? (
                <button onClick={() => { selectSatellite(live); onClose(); }}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-line text-[12px] text-ink hover:bg-raised flex-shrink-0">
                  <Crosshair className="w-3.5 h-3.5" /> Show live
                </button>
              ) : <span className="text-[11px] text-faint flex-shrink-0">Not in the loaded fleet</span>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
              <Fact label="Orbit" value={st.orbit} />
              <Fact label="Inclination" value={`${st.inclinationDeg}°`} />
              <Fact label="Mass" value={st.massT} />
              <Fact label="Crew" value={st.crew} />
            </div>
            <p className="text-[12px] text-muted mt-3"><span className="text-ink">First launch:</span> {st.firstLaunch}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {st.modules.map(m => <span key={m} className="text-[11px] px-1.5 py-0.5 rounded border border-line text-ink">{m}</span>)}
            </div>
            <p className="text-[12px] text-faint mt-3">{st.notes}</p>
          </article>
        );
      })}
    </div>
  );
};

const BodyDetail: React.FC<{ body: Body }> = ({ body }) => (
  <div className="space-y-4 animate-content-in" key={body.name}>
    <div>
      <h4 className="text-[18px] font-semibold text-ink">{body.name}</h4>
      <p className="text-[12px] text-muted capitalize">{body.kind}{body.name === 'Earth' ? ' · simulated in this dashboard' : ''}</p>
      <p className="text-[13px] text-ink mt-2">{body.summary}</p>
    </div>
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
      <Fact label="Mean radius" value={`${num(body.meanRadiusKm, 1)} km`} />
      <Fact label="GM (gravitational parameter)" value={body.gmKm3s2 == null ? 'not well measured' : `${num(body.gmKm3s2, 4)} km³/s²`} />
      {body.smaAu != null && <Fact label={body.kind === 'moon' ? 'Distance from the Sun' : 'Mean distance from the Sun'} value={`${num(body.smaAu, 3)} AU`} />}
      {body.orbitalPeriodDays != null && <Fact label={body.kind === 'moon' ? 'Orbital period (around its planet)' : 'Year'}
        value={body.orbitalPeriodDays >= 1000 ? `${num(body.orbitalPeriodDays / 365.25, 1)} years` : `${num(body.orbitalPeriodDays, 2)} days`} />}
      <Fact label="Rotation" value={`${num(Math.abs(body.rotationHours), 2)} h${body.rotationHours < 0 ? ' (retrograde)' : ''}`} />
      {body.knownMoons != null && <Fact label="Known moons" value={num(body.knownMoons)} />}
    </div>
    {body.majorMoons.length > 0 && (
      <section>
        <h5 className="text-[12px] font-semibold tracking-wider text-muted uppercase mb-1.5">Major moons</h5>
        <table className="w-full text-[13px]">
          <tbody className="tabular">
            {body.majorMoons.map(m => (
              <tr key={m.name} className="border-t border-line/60">
                <td className="py-1.5 pr-3 text-ink whitespace-nowrap">{m.name}</td>
                <td className="py-1.5 pr-3 text-muted whitespace-nowrap text-right">{num(m.radiusKm, 1)} km radius</td>
                <td className="py-1.5 text-[12px] text-faint">{m.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    )}
    <section>
      <h5 className="text-[12px] font-semibold tracking-wider text-muted uppercase mb-1.5">Spacecraft there</h5>
      {body.spacecraft.length === 0 ? <p className="text-[12px] text-faint">None active.</p> : (
        <ul className="space-y-1.5">
          {body.spacecraft.map(sc => (
            <li key={sc.name} className="flex items-baseline gap-2 text-[13px]">
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-line text-muted flex-shrink-0">{sc.role}</span>
              <span className="text-ink">{sc.name}</span>
              <span className="text-[12px] text-muted">{sc.agency}{sc.since !== '—' ? ` · ${sc.since}` : ''}</span>
              {sc.notes && <span className="text-[12px] text-faint">· {sc.notes}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  </div>
);

const SolarTab: React.FC = () => {
  const [selected, setSelected] = useState('Earth');
  const body = SOLAR_SYSTEM.find(b => b.name === selected) ?? SOLAR_SYSTEM[0];
  return (
    <div className="grid grid-cols-[180px_1fr] gap-5 min-h-[420px]">
      <nav aria-label="Bodies" className="border-r border-line pr-3">
        <ul className="space-y-0.5">
          {SOLAR_SYSTEM.map(b => (
            <li key={b.name}>
              <button onClick={() => setSelected(b.name)} aria-current={b.name === selected}
                className={`w-full text-left px-2.5 py-1.5 rounded-md text-[13px] ${b.name === selected ? 'bg-accent/15 text-ink' : 'text-muted hover:text-ink hover:bg-raised'}`}>
                <span className={b.kind === 'moon' ? 'pl-3' : ''}>{b.name}</span>
                <span className="block text-[10px] text-faint capitalize">{b.kind}{b.knownMoons ? ` · ${b.knownMoons} moon${b.knownMoons === 1 ? '' : 's'}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <BodyDetail body={body} />
    </div>
  );
};

export const LibraryModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('stations');
  return (
    <Modal title="Library" subtitle={`Space stations and the Solar System · facts as of ${AS_OF}; moon counts and missions change`}
      onClose={onClose} width={960}>
      <div role="tablist" aria-label="Library sections" className="flex gap-1 mb-4 border-b border-line">
        {([['stations', 'Space stations'], ['solar', 'Solar System']] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`no-press px-3 h-9 text-[13px] -mb-px border-b-2 ${tab === key ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'stations' ? <StationsTab onClose={onClose} /> : <SolarTab />}
    </Modal>
  );
};

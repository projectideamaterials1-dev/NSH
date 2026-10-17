// src/components/GroundStationsModal.tsx
// Ground stations page: the mission's own stations with live contact (which satellites each can talk to
// right now), and the major real-world tracking networks for reference. "Show" flies the map / globe there.

import React, { useMemo } from 'react';
import { Crosshair, Radio } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import useLayoutStore from '../store/layout';
import { elevationDeg } from '../lib/geo';
import { MISSION_STATIONS, REFERENCE_STATIONS, STATION_COLORS, type Station } from '../lib/stations';
import { Modal } from './ui';

const coord = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

const SHOWN_IN_CONTACT = 12;

export const GroundStationsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const satellites = useOrbitalStore(s => s.satellites);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const focusOn = useLayoutStore(s => s.focusOn);
  const showReference = useLayoutStore(s => s.showReferenceStations);
  const setShowReference = useLayoutStore(s => s.setShowReferenceStations);

  // Satellites above each mission station's elevation mask right now (same test as the map's contact lines).
  const inContact = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const st of MISSION_STATIONS) out[st.id] = [];
    if (!satellites) return out;
    for (let i = 0; i < satellites.length; i++) {
      const lon = satellites.positions[i * 3], lat = satellites.positions[i * 3 + 1], altKm = satellites.positions[i * 3 + 2] / 1000;
      for (const st of MISSION_STATIONS) {
        if (elevationDeg(lat, lon, altKm, st.lat, st.lon) >= (st.minElevationDeg ?? 0)) out[st.id].push(satellites.ids[i]);
      }
    }
    return out;
  }, [satellites]);

  const show = (st: Station) => {
    if (st.role === 'reference') setShowReference(true);
    focusOn(st.lat, st.lon);
    onClose();
  };
  const pick = (id: string) => { selectSatellite(id); onClose(); };

  const networks = useMemo(() => {
    const by = new Map<string, Station[]>();
    for (const st of REFERENCE_STATIONS) by.set(st.network, [...(by.get(st.network) ?? []), st]);
    return [...by.entries()];
  }, []);

  return (
    <Modal title="Ground stations" subtitle="Where satellites are commanded and heard from" onClose={onClose} width={900}>
      <div className="space-y-6 text-[13px]">
        <section>
          <div className="flex items-end justify-between gap-3 mb-2">
            <div>
              <h4 className="text-[12px] font-semibold tracking-wider text-muted uppercase">Mission network</h4>
              <p className="text-[12px] text-faint">Used for contact status and uplink windows: a burn can only be commanded while one of these sees the satellite.</p>
            </div>
          </div>
          <ul className="divide-y divide-line/60 border border-line rounded-lg">
            {MISSION_STATIONS.map(st => {
              const sats = inContact[st.id] ?? [];
              return (
                <li key={st.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-1.5 w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: sats.length ? 'var(--color-ok)' : STATION_COLORS.mission }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold text-ink">{st.name}</span>
                        <span className="text-[12px] text-muted">{st.network} · {st.operator} · {st.country}</span>
                      </div>
                      <div className="text-[12px] text-muted tabular">{coord(st.lat, st.lon)} · elevation mask {st.minElevationDeg}°</div>
                      {st.notes && <p className="text-[12px] text-faint mt-0.5">{st.notes}</p>}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex items-center gap-1 text-[12px] ${sats.length ? 'text-ok' : 'text-muted'}`}>
                          <Radio className="w-3.5 h-3.5" />
                          {sats.length ? `${sats.length.toLocaleString()} satellite${sats.length === 1 ? '' : 's'} in contact` : 'No satellite in view'}
                        </span>
                        {sats.slice(0, SHOWN_IN_CONTACT).map(id => (
                          <button key={id} onClick={() => pick(id)} className="tabular text-[11px] px-1.5 py-0.5 rounded border border-line text-ink hover:border-accent hover:text-accent">
                            {id}
                          </button>
                        ))}
                        {sats.length > SHOWN_IN_CONTACT && <span className="text-[11px] text-faint">+{(sats.length - SHOWN_IN_CONTACT).toLocaleString()} more</span>}
                      </div>
                    </div>
                    <button onClick={() => show(st)} className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-line text-[12px] text-ink hover:bg-raised flex-shrink-0">
                      <Crosshair className="w-3.5 h-3.5" /> Show
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <div className="flex items-end justify-between gap-3 mb-2">
            <div>
              <h4 className="text-[12px] font-semibold tracking-wider text-muted uppercase">Major tracking networks</h4>
              <p className="text-[12px] text-faint">For reference: these are not used for contact or uplink decisions here. Coordinates are approximate.</p>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-ink cursor-pointer flex-shrink-0">
              <input type="checkbox" checked={showReference} onChange={e => setShowReference(e.target.checked)} className="accent-[var(--color-accent)]" />
              Show on map and globe
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: STATION_COLORS.reference }} />
            </label>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {networks.map(([network, stations]) => (
              <div key={network} className="border border-line rounded-lg p-3">
                <div className="font-semibold text-ink mb-1.5">{network}</div>
                <ul className="space-y-2">
                  {stations.map(st => (
                    <li key={st.id} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-ink">{st.name} <span className="text-[12px] text-muted">· {st.country}</span></div>
                        <div className="text-[11px] text-faint">{st.notes}</div>
                      </div>
                      <button onClick={() => show(st)} aria-label={`Show ${st.name}`} title="Show on map"
                        className="p-1 rounded text-muted hover:text-accent hover:bg-raised flex-shrink-0">
                        <Crosshair className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
};

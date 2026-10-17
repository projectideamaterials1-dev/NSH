// src/components/SatelliteCard.tsx
// Compact card shown on the map / globe next to the selected satellite: the key facts at a glance, without
// looking away to the side panel. "Details" opens the full satellite panel.

import React from 'react';
import { PanelLeftOpen, X } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import useLayoutStore from '../store/layout';
import { fuelColor, fuelPercent, MODE_META, riskMeta, statusMeta } from '../lib/format';

export const CARD_WIDTH = 228;
const CARD_HEIGHT = 176;
const GAP = 18;

/** Where to put the card's top-left corner for an anchor at (x, y): right of the point, flipped to the
 *  left / downwards when it would leave the view. */
export function cardPosition(x: number, y: number, viewWidth: number, viewHeight: number) {
  const left = x + GAP + CARD_WIDTH > viewWidth - 8 ? x - GAP - CARD_WIDTH : x + GAP;
  const top = Math.min(Math.max(8, y - CARD_HEIGHT / 2), viewHeight - CARD_HEIGHT - 8);
  return { left: Math.max(8, left), top };
}

interface Props {
  id: string;
  altKm: number;
  fuelKg: number;
  status: string;
  /** Mission ground station currently in contact, if any. */
  contactStation: string | null;
}

export const SatelliteCard: React.FC<Props> = ({ id, altKm, fuelKg, status, contactStation }) => {
  const detail = useOrbitalStore(s => s.satelliteDetails[id]);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const leftCollapsed = useLayoutStore(s => s.collapsed.left);
  const togglePanel = useLayoutStore(s => s.togglePanel);
  const mode = detail?.mode ? MODE_META[detail.mode] : null;
  const threat = detail?.threat ?? null;
  const color = fuelColor(fuelKg);

  return (
    <div role="dialog" aria-label={`${id} summary`}
      className="w-[228px] rounded-lg border border-line bg-panel/95 shadow-2xl backdrop-blur-sm text-[12px] animate-pop-in pointer-events-auto"
      onPointerDown={e => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
        <div className="min-w-0">
          <div className="tabular text-[13px] font-semibold text-ink truncate" title={id}>{id}</div>
          <div className="text-[11px]" style={{ color: mode?.color ?? statusMeta(status).color }}>
            {mode?.label ?? statusMeta(status).label}
          </div>
        </div>
        <button onClick={() => selectSatellite(null)} aria-label="Close" className="p-1 -mr-1 rounded text-muted hover:text-ink hover:bg-raised">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 tabular">
        <dt className="text-muted">Altitude</dt><dd className="text-right text-ink">{altKm.toFixed(1)} km</dd>
        <dt className="text-muted">Fuel</dt>
        <dd className="flex items-center justify-end gap-2">
          <span className="w-14 h-1.5 rounded-full bg-raised overflow-hidden">
            <span className="block h-full rounded-full" style={{ width: `${fuelPercent(fuelKg)}%`, background: color }} />
          </span>
          <span style={{ color }}>{fuelKg.toFixed(1)} kg</span>
        </dd>
        <dt className="text-muted">Contact</dt>
        <dd className={`text-right truncate ${contactStation ? 'text-ok' : 'text-muted'}`} title={contactStation ?? undefined}>
          {contactStation ?? 'No contact'}
        </dd>
        <dt className="text-muted">Threat</dt>
        <dd className="text-right" style={{ color: threat ? riskMeta(threat).color : undefined }}>
          {threat ? riskMeta(threat).label : <span className="text-muted">None</span>}
        </dd>
        {detail && detail.drift_km > 0.05 && (<>
          <dt className="text-muted">Slot drift</dt><dd className="text-right text-ink">{detail.drift_km.toFixed(2)} km</dd>
        </>)}
      </dl>
      {leftCollapsed && (
        <div className="px-3 pb-2.5">
          <button onClick={() => togglePanel('left')}
            className="w-full h-7 flex items-center justify-center gap-1.5 rounded-md border border-line text-ink hover:bg-raised">
            <PanelLeftOpen className="w-3.5 h-3.5" /> Details
          </button>
        </div>
      )}
    </div>
  );
};

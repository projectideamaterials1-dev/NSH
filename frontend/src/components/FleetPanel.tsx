// src/components/FleetPanel.tsx
// Fleet list (search, sort, live mode/contact/threat indicators), fuel heatmap and photo gallery.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Image, LayoutGrid, List, Radio, Search } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import { fuelColor, fuelPercent, riskMeta, statusMeta, MODE_META, FUEL_INITIAL_KG } from '../lib/format';
import { EmptyState, StatusDot } from './ui';
import { FleetGallery, SatelliteThumb } from './SatellitePhoto';
import { FleetSizeControl } from './FleetSizeControl';
import { useVirtualRows } from '../lib/useVirtualRows';

type SortKey = 'status' | 'fuel' | 'id' | 'threat';
interface Row { id: string; fuel: number; status: string; mode?: string; contact?: boolean; threat?: string | null; drift?: number }

const STATUS_RANK: Record<string, number> = { EOL: 0, CRITICAL: 1, CRITICAL_FUEL: 1, WARNING: 2, NOMINAL: 3 };
const THREAT_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, WATCH: 2 };
/** Natural order (SAT-2 before SAT-10). One shared collator: localeCompare with options builds one per call. */
const ID_ORDER = new Intl.Collator(undefined, { numeric: true });

/** Continuous red → amber → green scale for the heatmap. */
export function heatColor(fuelKg: number): string {
  const t = Math.max(0, Math.min(1, fuelKg / FUEL_INITIAL_KG));
  const stops = [[248, 81, 73], [227, 160, 8], [63, 185, 80]];
  const seg = t < 0.5 ? 0 : 1;
  const local = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const rgb = stops[seg].map((v, i) => Math.round(v + (stops[seg + 1][i] - v) * local));
  return `rgb(${rgb.join(',')})`;
}

interface RowProps extends Row { selected: boolean; photo: boolean; onToggle: (id: string) => void }

const FleetRow = memo(React.forwardRef<HTMLButtonElement, RowProps>(
  ({ id, fuel, status, mode: modeKey, contact, threat, drift, selected, photo, onToggle }, ref) => {
    const color = fuelColor(fuel);
    const mode = modeKey && modeKey !== 'NOMINAL' ? MODE_META[modeKey] : null;
    return (
      <li>
        <button
          ref={ref}
          onClick={() => onToggle(id)}
          className={`w-full grid ${photo ? 'grid-cols-[auto_auto_1fr_auto_40px_auto] gap-2.5' : 'grid-cols-[auto_1fr_auto_72px_60px] gap-3'} no-press items-center px-4 h-12 text-left border-b border-line/60 transition-[background-color,box-shadow] duration-200 ease-out-quart active:bg-raised/80 ${
            selected ? 'bg-accent/10 shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-raised'
          }`}
        >
          {photo && <SatelliteThumb id={id} />}
          <StatusDot status={status} />
          <span className="min-w-0">
            <span className="block tabular text-[13px] text-ink truncate">{id}</span>
            <span className="block text-[11px] leading-tight truncate" style={{ color: mode?.color ?? statusMeta(status).color }}>
              {mode?.label ?? statusMeta(status).label}
              {drift !== undefined && drift > 0.05 && <span className="text-faint"> · {drift.toFixed(1)} km drift</span>}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            {threat && (threat === 'CRITICAL' || threat === 'WARNING') && (
              <AlertTriangle className="w-3.5 h-3.5" style={{ color: riskMeta(threat).color }} aria-label={`${threat} threat`} />
            )}
            <Radio className={`w-3.5 h-3.5 transition-colors duration-300 ${contact ? 'text-ok' : 'text-line-strong'}`} aria-label={contact ? 'In ground contact' : 'No ground contact'} />
          </span>
          <span className="h-1.5 rounded-full bg-raised border border-line overflow-hidden">
            <span className="block h-full rounded-full transition-[width,background-color] duration-500 ease-out-quart" style={{ width: `${fuelPercent(fuel)}%`, background: color }} />
          </span>
          <span className="tabular text-[13px] text-right whitespace-nowrap" style={{ color }}>{fuel.toFixed(1)} kg</span>
        </button>
      </li>
    );
  }));

const HeatCell = memo(React.forwardRef<HTMLButtonElement, RowProps>(({ id, fuel, status, threat, selected, onToggle }, ref) => (
  <button
    ref={ref}
    onClick={() => onToggle(id)}
    title={`${id} · ${fuel.toFixed(1)} kg · ${statusMeta(status).label}`}
    className={`relative aspect-square rounded-md flex flex-col items-center justify-center text-[#07090d] transition-[transform,background-color,box-shadow] duration-200 ease-out-quart hover:scale-105 active:scale-95 ${
      selected ? 'ring-2 ring-offset-2 ring-offset-panel ring-accent' : ''
    }`}
    style={{ background: heatColor(fuel) }}
  >
    {threat === 'CRITICAL' && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#07090d]" />}
    <span className="tabular text-[11px] font-semibold leading-none">{id.replace(/^SAT-?/, '')}</span>
    <span className="tabular text-[10px] leading-none mt-1 opacity-80">{fuel.toFixed(0)}</span>
  </button>
)));

const ROW_H = 48;          // FleetRow is h-12
const GRID_PAGE = 500;

const ShowMore: React.FC<{ shown: number; total: number; onMore: () => void }> = ({ shown, total, onMore }) =>
  shown >= total ? null : (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-[12px] text-muted">
      <span className="tabular">Showing {shown} of {total}</span>
      <button onClick={onMore} className="h-7 px-2.5 rounded-md border border-line text-ink hover:bg-raised">Show {Math.min(GRID_PAGE, total - shown)} more</button>
    </div>
  );

export const FleetPanel: React.FC = () => {
  const satellites = useOrbitalStore(s => s.satellites);
  const details = useOrbitalStore(s => s.satelliteDetails);
  const selectedId = useOrbitalStore(s => s.selectedSatelliteId);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const realWorldLoaded = useOrbitalStore(s => s.realWorld?.loaded ?? false);
  const [view, setView] = useState<'list' | 'heatmap' | 'gallery'>('list');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('status');
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Heatmap and photo grids are not windowed: show them in pages (the gallery loads one photo per tile).
  const [gridLimit, setGridLimit] = useState(GRID_PAGE);

  const rows = useMemo<Row[]>(() => {
    if (!satellites) return [];
    const out: Row[] = [];
    const q = query.trim().toLowerCase();
    for (let i = 0; i < satellites.length; i++) {
      const id = satellites.ids[i];
      if (q && !id.toLowerCase().includes(q)) continue;
      const d = details[id];
      out.push({ id, fuel: Math.round(satellites.fuels[i] * 10) / 10, status: satellites.statuses[i], mode: d?.mode, contact: d?.in_contact, threat: d?.threat, drift: d?.drift_km === undefined ? undefined : Math.round(d.drift_km * 10) / 10 });
    }
    const byId = (a: Row, b: Row) => ID_ORDER.compare(a.id, b.id);
    const threatRank = (r: Row) => (r.threat ? THREAT_RANK[r.threat] ?? 9 : 9);
    return out.sort((a, b) =>
      sort === 'id' ? byId(a, b)
        : sort === 'fuel' ? a.fuel - b.fuel || byId(a, b)
          : sort === 'threat' ? threatRank(a) - threatRank(b) || byId(a, b)
            : threatRank(a) - threatRank(b) || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.fuel - b.fuel || byId(a, b)
    );
  }, [satellites, details, query, sort]);

  const win = useVirtualRows(scrollRef, view === 'list' ? rows.length : 0, ROW_H);
  const { scrollToIndex } = win;

  // Keep the selected satellite visible when it is picked on the map (its row may not be rendered yet).
  useEffect(() => {
    if (view === 'list') scrollToIndex(rows.findIndex(r => r.id === selectedId));
    else selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
    // rows deliberately left out: re-scrolling on every telemetry frame would fight the user's scrolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, view, scrollToIndex]);
  useEffect(() => setGridLimit(GRID_PAGE), [view, query, sort]);

  const total = satellites?.length ?? 0;
  const toggle = useCallback((id: string) => selectSatellite(id === useOrbitalStore.getState().selectedSatelliteId ? null : id), [selectSatellite]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex gap-2 px-4 py-3 border-b border-line">
        <label className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Search ${total} satellites`}
            className="w-full h-8 pl-8 pr-2 rounded-md bg-raised border border-line text-[13px] text-ink placeholder:text-faint focus:outline-none focus:border-accent"
          />
        </label>
        <select
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
          className="h-8 px-2 rounded-md bg-raised border border-line text-[13px] text-ink focus:outline-none focus:border-accent"
          aria-label="Sort fleet"
        >
          <option value="status">Priority</option>
          <option value="threat">Threat</option>
          <option value="fuel">Fuel (low first)</option>
          <option value="id">ID</option>
        </select>
        <div className="flex rounded-md border border-line overflow-hidden" role="tablist" aria-label="Fleet view">
          {([['list', List, 'List'], ['heatmap', LayoutGrid, 'Fuel heatmap'], ['gallery', Image, 'Photos']] as const).map(([key, Icon, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={view === key}
              aria-label={label}
              title={label}
              onClick={() => setView(key)}
              className={`flex items-center justify-center w-8 h-8 transition-colors ${view === key ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>
      </div>
      <FleetSizeControl />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {total === 0 ? (
          <EmptyState title="No fleet data">Satellites appear here once telemetry is ingested.</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState title="No matches">No satellite ID contains “{query}”.</EmptyState>
        ) : view === 'list' ? (
          <ul style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
            {rows.slice(win.start, win.end).map(r => (
              <FleetRow key={r.id} {...r} selected={r.id === selectedId} photo={realWorldLoaded} onToggle={toggle}
                ref={r.id === selectedId ? selectedRowRef : undefined} />
            ))}
          </ul>
        ) : view === 'gallery' ? (
          <>
            <FleetGallery ids={rows.slice(0, gridLimit).map(r => r.id)} selectedId={selectedId} onSelect={toggle} />
            <ShowMore shown={Math.min(gridLimit, rows.length)} total={rows.length} onMore={() => setGridLimit(l => l + GRID_PAGE)} />
          </>
        ) : (
          <div className="p-4">
            <div className="grid grid-cols-5 gap-1.5">
              {rows.slice(0, gridLimit).map(r => (
                <HeatCell key={r.id} {...r} selected={r.id === selectedId} photo={false} onToggle={toggle}
                  ref={r.id === selectedId ? selectedRowRef : undefined} />
              ))}
            </div>
            <ShowMore shown={Math.min(gridLimit, rows.length)} total={rows.length} onMore={() => setGridLimit(l => l + GRID_PAGE)} />
            <div className="mt-4">
              <div className="h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${heatColor(0)}, ${heatColor(25)}, ${heatColor(50)})` }} />
              <div className="flex justify-between text-[11px] text-muted mt-1 tabular">
                <span>0 kg</span><span>25 kg</span><span>50 kg</span>
              </div>
              <p className="text-[11px] text-faint mt-2">A dot marks satellites with a critical conjunction.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FleetPanel;

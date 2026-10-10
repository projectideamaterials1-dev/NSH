// src/components/SatellitePhoto.tsx
// Real photos of the loaded real-world satellites (Wikimedia Commons via Wikidata / Wikipedia):
// list thumbnail, details-panel card and a full-size viewer with author and licence credit.

import React, { useState } from 'react';
import { ExternalLink, ImageOff, Satellite } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { SatelliteImagery } from '../store/useOrbitalStore';
import { Modal } from './ui';

const useImagery = (id: string): SatelliteImagery | null | undefined => useOrbitalStore(s => s.imagery[id]);

/** Square thumbnail; a satellite glyph when there is no photo (or none loaded yet). */
export const SatelliteThumb: React.FC<{ id: string; size?: number }> = ({ id, size = 32 }) => {
  const info = useImagery(id);
  const [failed, setFailed] = useState(false);
  const photo = failed ? null : info?.photo;
  return (
    <span className="flex-shrink-0 rounded-md overflow-hidden bg-raised border border-line flex items-center justify-center"
      style={{ width: size, height: size }}>
      {photo ? (
        <img src={photo.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}
          className="w-full h-full object-cover" />
      ) : (
        <Satellite className="text-faint" style={{ width: size * 0.5, height: size * 0.5 }} />
      )}
    </span>
  );
};

const Credit: React.FC<{ info: SatelliteImagery }> = ({ info }) => {
  const photo = info.photo!;
  return (
    <span className="text-faint">
      {photo.credit ? `${photo.credit} · ` : ''}{photo.license ?? 'see licence'} ·{' '}
      <a href={photo.page_url ?? photo.full_url ?? photo.image_url} target="_blank" rel="noreferrer" className="hover:text-ink underline-offset-2 hover:underline">
        Wikimedia Commons
      </a>
    </span>
  );
};

const PhotoViewer: React.FC<{ id: string; info: SatelliteImagery; onClose: () => void }> = ({ id, info, onClose }) => (
  <Modal title={info.match === 'family' ? `${id} — representative photo (${info.family ?? info.title})` : info.title}
    subtitle={`${id} · NORAD ${info.norad_id}${info.description ? ` · ${info.description}` : ''}`} onClose={onClose} width={960}>
    <div className="p-5 space-y-3 overflow-y-auto">
      <img src={info.photo!.full_url ?? info.photo!.image_url} alt={info.title} referrerPolicy="no-referrer"
        className="w-full max-h-[62vh] object-contain rounded-lg bg-black" />
      {info.photo!.caption && <p className="text-[13px] text-muted">{info.photo!.caption}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <Credit info={info} />
        {info.article_url && (
          <a href={info.article_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            Wikipedia <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  </Modal>
);

/** Photo card for the selected satellite. Renders nothing when imagery isn't available (simulated fleets). */
export const SatellitePhotoCard: React.FC<{ id: string }> = ({ id }) => {
  const info = useImagery(id);
  const loaded = useOrbitalStore(s => s.realWorld?.loaded ?? false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (!loaded) return null;
  if (info === undefined) {
    return <div className="h-40 rounded-lg border border-line bg-raised animate-pulse" aria-label="Loading photo" />;
  }
  const photo = info && failed !== info.photo?.image_url ? info.photo : null;

  if (!info || !photo) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-[12px] text-muted">
        <ImageOff className="w-4 h-4 flex-shrink-0 text-faint" />
        <span className="min-w-0">
          {info === null ? 'Photo not looked up yet — retrying shortly.' : 'No public photo of this spacecraft.'}
          {info?.article_url && (
            <> <a href={info.article_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{info.title} on Wikipedia</a></>
          )}
        </span>
      </div>
    );
  }

  return (
    <figure className="rounded-lg border border-line bg-raised overflow-hidden">
      <button onClick={() => setOpen(true)} className="block w-full group" title="View full size">
        <img src={photo.image_url} alt={info.title} referrerPolicy="no-referrer" onError={() => setFailed(photo.image_url)}
          className="w-full h-44 object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
      </button>
      <figcaption className="px-3 py-2 text-[12px] space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink font-medium truncate" title={info.title}>{info.title}</span>
          {info.article_url && (
            <a href={info.article_url} target="_blank" rel="noreferrer" aria-label="Wikipedia article" className="text-muted hover:text-accent flex-shrink-0">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
        {info.match === 'name' && <div className="text-[11px] text-warn">Matched by name — may show a related spacecraft.</div>}
        {info.match === 'family' && <div className="text-[11px] text-warn">Representative photo of the {info.family ?? info.title} family, not this exact satellite.</div>}
        <div className="text-[11px] truncate"><Credit info={info} /></div>
      </figcaption>
      {open && <PhotoViewer id={id} info={info} onClose={() => setOpen(false)} />}
    </figure>
  );
};

/** Photo grid of the whole fleet; satellites with a photo first. */
export const FleetGallery: React.FC<{ ids: string[]; selectedId: string | null; onSelect: (id: string) => void }> = ({ ids, selectedId, onSelect }) => {
  const imagery = useOrbitalStore(s => s.imagery);
  const loaded = useOrbitalStore(s => s.realWorld?.loaded ?? false);
  const ordered = [...ids].sort((a, b) => Number(Boolean(imagery[b]?.photo)) - Number(Boolean(imagery[a]?.photo)));
  const withPhoto = ids.filter(id => imagery[id]?.photo).length;
  const pending = ids.filter(id => imagery[id] === null).length;

  if (!loaded) {
    return <p className="p-4 text-[13px] text-muted">Photos are available for real satellites — load them from Data sources.</p>;
  }
  return (
    <div className="p-4">
      <p className="text-[11px] text-faint mb-3">
        {Object.keys(imagery).length === 0 ? 'Looking up photos on Wikimedia…' : `${withPhoto} of ${ids.length} satellites have a public photo`
          + (pending ? ` · ${pending} still being looked up` : '.')}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {ordered.map(id => {
          const info = imagery[id];
          return (
            <button key={id} onClick={() => onSelect(id)} title={info?.title ?? id}
              className={`text-left rounded-lg border overflow-hidden bg-raised transition-colors ${
                id === selectedId ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong'}`}>
              <span className="block aspect-[4/3] bg-panel">
                {info?.photo ? (
                  <img src={info.photo.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                ) : (
                  <span className="w-full h-full flex items-center justify-center"><Satellite className="w-7 h-7 text-line-strong" /></span>
                )}
              </span>
              <span className="block px-2 py-1.5">
                <span className="block tabular text-[12px] text-ink truncate">{id}</span>
                <span className="block text-[11px] text-muted truncate">
                  {info?.photo ? (info.match === 'family' ? `${info.family ?? info.title} (representative)` : info.title) : info === null ? 'Looking up…' : 'No public photo'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

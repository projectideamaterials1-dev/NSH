// src/store/layout.ts
// Dashboard layout preferences: which side panels are collapsed (remembered per browser) and
// whether the page is in fullscreen (mirrors the browser's own fullscreen state, so Esc stays in sync).

import { create } from 'zustand';

export type Side = 'left' | 'right';

const STORAGE_KEY = 'nsh.layout.collapsed';

function load(): Record<Side, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { left: raw.left === true, right: raw.right === true };
  } catch {
    return { left: false, right: false };
  }
}

function save(collapsed: Record<Side, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    // private mode / blocked storage: the preference just isn't remembered
  }
}

interface LayoutState {
  collapsed: Record<Side, boolean>;
  fullscreen: boolean;
  togglePanel: (side: Side) => void;
  setPanels: (collapsed: Record<Side, boolean>) => void;
  /** Map-only focus: both panels collapse; pressing it again brings them back. */
  toggleFocus: () => void;
  toggleFullscreen: () => Promise<void>;
  /** A request for the map / globe to fly to a point (e.g. a ground station picked in a list). */
  focus: { lat: number; lon: number; seq: number } | null;
  focusOn: (lat: number, lon: number) => void;
  /** Show the reference tracking networks (not used for contact) on the map and globe. */
  showReferenceStations: boolean;
  setShowReferenceStations: (show: boolean) => void;
}

const useLayoutStore = create<LayoutState>((set, get) => ({
  focus: null,
  focusOn: (lat, lon) => set({ focus: { lat, lon, seq: (get().focus?.seq ?? 0) + 1 } }),
  showReferenceStations: false,
  setShowReferenceStations: show => set({ showReferenceStations: show }),
  collapsed: load(),
  fullscreen: typeof document !== 'undefined' && !!document.fullscreenElement,
  togglePanel: side => {
    const collapsed = { ...get().collapsed, [side]: !get().collapsed[side] };
    save(collapsed);
    set({ collapsed });
  },
  setPanels: collapsed => {
    save(collapsed);
    set({ collapsed });
  },
  toggleFocus: () => {
    const { left, right } = get().collapsed;
    const focused = left && right;
    get().setPanels({ left: !focused, right: !focused });
  },
  toggleFullscreen: async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // refused (iframe without allowfullscreen, no user gesture): stay as we are
    }
  },
}));

if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => useLayoutStore.setState({ fullscreen: !!document.fullscreenElement }));
}

export default useLayoutStore;

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
}

const useLayoutStore = create<LayoutState>((set, get) => ({
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

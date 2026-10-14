// src/store/watchlist.ts
// The operator's watchlist: objects whose maneuvers and re-entries they want to follow. A per-viewer
// preference, so it lives in this browser's storage (it never affects the mission).

import { create } from 'zustand';

const STORAGE_KEY = 'nsh.watchlist';

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface WatchlistState {
  ids: string[];
  toggle: (id: string) => void;
  has: (id: string) => boolean;
}

const useWatchlist = create<WatchlistState>((set, get) => ({
  ids: load(),
  toggle: id => {
    const ids = get().ids.includes(id) ? get().ids.filter(x => x !== id) : [...get().ids, id];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // storage blocked: the watchlist lasts for this session only
    }
    set({ ids });
  },
  has: id => get().ids.includes(id),
}));

export default useWatchlist;

// src/lib/useVirtualRows.ts
// Windowing for long fixed-height lists: only the rows in (and a little around) the scroll viewport are
// rendered, so a 12,000-satellite fleet costs the same to draw as a 30-row one.

import { RefObject, useCallback, useEffect, useState } from 'react';

export interface VirtualRows {
  start: number;
  end: number;          // exclusive
  padTop: number;       // px of empty space standing in for the rows above `start`
  padBottom: number;    // ... and below `end`
  /** Scrolls the minimum needed to bring row `index` fully into view. */
  scrollToIndex: (index: number) => void;
}

export function useVirtualRows(scrollRef: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan = 8): VirtualRows {
  const [view, setView] = useState({ top: 0, height: 800 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const read = () => { frame = 0; setView(v => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight })); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [scrollRef]);

  const start = Math.max(0, Math.min(count, Math.floor(view.top / rowHeight) - overscan));
  const end = Math.max(start, Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + overscan));

  const scrollToIndex = useCallback((index: number) => {
    const el = scrollRef.current;
    if (!el || index < 0) return;
    const top = index * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [scrollRef, rowHeight]);

  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight, scrollToIndex };
}

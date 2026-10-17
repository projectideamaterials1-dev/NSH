// src/components/ui.tsx
// Small, consistent UI primitives shared by all dashboard panels.

import React, { Component, ErrorInfo, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { STATUS_META, statusMeta } from '../lib/format';

export const Panel: React.FC<{
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}> = ({ title, actions, className = '', bodyClassName = '', children }) => (
  <section className={`flex flex-col flex-shrink-0 border-b border-line ${className}`}>
    {(title || actions) && (
      <header className="flex items-center justify-between gap-2 px-4 h-10 flex-shrink-0">
        <h2 className="section-title">{title}</h2>
        {actions}
      </header>
    )}
    <div className={`min-h-0 ${bodyClassName}`}>{children}</div>
  </section>
);

export const StatusBadge: React.FC<{ status: string; size?: 'sm' | 'md' }> = ({ status, size = 'sm' }) => {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap ${
        size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
      }`}
      style={{ color: meta.color, borderColor: `${meta.color}55`, background: `${meta.color}14` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
};

export const StatusDot: React.FC<{ status: keyof typeof STATUS_META | string }> = ({ status }) => (
  <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusMeta(status).color }} />
);

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; icon?: ReactNode }
> = ({ variant = 'secondary', icon, className = '', children, ...props }) => {
  const styles = {
    primary: 'bg-accent text-[#04121f] hover:brightness-110 border-transparent font-semibold',
    secondary: 'bg-raised text-ink border-line hover:border-line-strong hover:bg-[#1b2430]',
    ghost: 'bg-transparent text-muted border-transparent hover:text-ink hover:bg-raised',
  }[variant];
  const iconOnly = children === undefined || children === null;
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 h-8 rounded-md border text-[13px] whitespace-nowrap
        transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 ease-out-quart
        active:scale-[0.96] active:duration-75
        [&>svg]:flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent
        ${iconOnly ? 'w-8' : 'px-3'} ${styles} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
};

/** Keeps a component mounted for `exitMs` after `open` turns false so it can play an exit animation.
 *  `closing` is true during that window. Reduced-motion users get an instant unmount. */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setMounted(false); return; }
    const id = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(id);
  }, [open, exitMs]);
  return { mounted: open || mounted, closing: !open && mounted };
}

let modalSeq = 0;
const MODAL_EXIT_MS = 150;
// Open dialogs, innermost last: only the top one handles Escape/Tab (a burn planner opened from the
// conjunction view must not close both).
const modalStack: number[] = [];
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Modal: React.FC<{
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}> = ({ title, subtitle, onClose, width = 720, children }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [seq] = useState(() => ++modalSeq);
  const titleId = `modal-title-${seq}`;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Escape, the backdrop and the close button play the exit animation first; a parent that unmounts
  // the dialog itself (e.g. after a successful submit) skips it.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { onCloseRef.current(); return; }
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(), MODAL_EXIT_MS);
  }, []);

  // Escape closes; Tab stays inside the dialog; focus moves in on open and back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)?.focus();
    modalStack.push(seq);
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== seq) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const at = modalStack.lastIndexOf(seq);
      if (at >= 0) modalStack.splice(at, 1);
      opener?.focus?.();
    };
  }, [seq, requestClose]);

  // Portalled to <body>: an ancestor with a transform (panel enter animations) or overflow clipping
  // would otherwise trap the "fixed" overlay inside that panel.
  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-[2px] p-2 sm:p-6 ${closing ? 'animate-fade-out' : 'animate-fade-in'}`}
      onClick={requestClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-panel border border-line rounded-xl shadow-2xl flex flex-col max-h-[94dvh] sm:max-h-[88vh] w-full focus:outline-none will-change-transform ${closing ? 'animate-dialog-out' : 'animate-dialog-in'}`}
        style={{ maxWidth: width }}
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 px-4 sm:px-5 py-4 border-b border-line">
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-semibold text-ink">{title}</h3>
            {subtitle && <p className="text-[13px] text-muted mt-0.5">{subtitle}</p>}
          </div>
          <Button variant="ghost" onClick={requestClose} aria-label="Close" icon={<X className="w-4 h-4" />} />
        </header>
        <div className="overflow-y-auto p-4 sm:p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
};

export const EmptyState: React.FC<{ icon?: ReactNode; title: string; children?: ReactNode }> = ({ icon, title, children }) => (
  <div className="flex flex-col items-center justify-center text-center gap-2 px-6 py-10 text-muted">
    {icon && <div className="text-faint mb-1">{icon}</div>}
    <p className="text-sm font-medium text-ink">{title}</p>
    {children && <div className="text-[13px] leading-relaxed">{children}</div>}
  </div>
);

export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}]`, error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-4 text-[13px] text-crit">
        {this.props.name} failed to render.{' '}
        <button className="underline" onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}

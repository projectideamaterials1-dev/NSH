// src/components/ui.tsx
// Small, consistent UI primitives shared by all dashboard panels.

import React, { Component, ErrorInfo, ReactNode, useEffect } from 'react';
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
      className={`inline-flex items-center justify-center gap-2 h-8 rounded-md border text-[13px] whitespace-nowrap transition-colors
        [&>svg]:flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent
        ${iconOnly ? 'w-8' : 'px-3'} ${styles} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
};

export const Modal: React.FC<{
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}> = ({ title, subtitle, onClose, width = 720, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-panel border border-line rounded-xl shadow-2xl flex flex-col max-h-[88vh] w-full"
        style={{ maxWidth: width }}
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
          <div>
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            {subtitle && <p className="text-[13px] text-muted mt-0.5">{subtitle}</p>}
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close" icon={<X className="w-4 h-4" />} />
        </header>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
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

import { Terminal, ShieldAlert, Satellite } from 'lucide-react';

export function Header() {
  return (
    <header className="h-14 bg-black/60 backdrop-blur-md border-b border-red-900/50 shadow-[0_0_15px_rgba(220,38,38,0.2)] flex items-center justify-between px-6 z-20">
      <div className="flex items-center gap-3">
        <Terminal className="w-5 h-5 text-[#00FFFF] drop-shadow-[0_0_8px_rgba(0,255,255,0.8)]" />
        <h1 className="text-sm font-bold tracking-[0.2em] text-[#00FFFF] drop-shadow-[0_0_5px_rgba(0,255,255,0.5)] uppercase">Orbital Insight</h1>
        <span className="text-xs text-[#888888] ml-4 font-mono">v2.0.4 <span className="text-red-900/80">///</span> CYBER-COMMAND</span>
      </div>
      <div className="flex items-center gap-6 text-xs font-mono">
        <div className="flex items-center gap-2">
          <Satellite className="w-4 h-4 text-[#00FFFF] drop-shadow-[0_0_5px_rgba(0,255,255,0.5)]" />
          <span className="text-[#00FFFF] drop-shadow-[0_0_5px_rgba(0,255,255,0.5)]">200 ACTIVE</span>
        </div>
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-[#FF0033] drop-shadow-[0_0_5px_rgba(255,0,51,0.5)]" />
          <span className="text-[#FF0033] drop-shadow-[0_0_5px_rgba(255,0,51,0.5)]">100,000+ DEBRIS</span>
        </div>
        <div className="px-3 py-1 bg-black/40 border border-[#FF0033]/50 rounded text-[#FF0033] animate-pulse shadow-[0_0_10px_rgba(255,0,51,0.3)]">
          DEFCON 3
        </div>
      </div>
    </header>
  );
}

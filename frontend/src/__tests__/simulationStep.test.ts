import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSimulationActions } from '../store/slices/simulation';

afterEach(() => vi.unstubAllGlobals());

describe('simulation step', () => {
  it('stops quietly and picks up live mode when the backend went live first (409)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Live mode keeps simulation time at real UTC; turn live mode off (PUT /api/live) to step manually.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } })));
    let state: Record<string, any> = {
      _stepInFlight: false, _simInterval: null, isSimulationRunning: true, realWorld: { live: false },
      simulation: { status: 'running', error: null, stepsRun: 0, collisionsDetected: 0, maneuversExecuted: 0 },
    };
    const set = (p: any) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; };
    const get = () => state as any;
    const fetchRealWorld = vi.fn(async () => set({ realWorld: { live: true } }));
    Object.assign(state, createSimulationActions(set as any, get), { fetchRealWorld });

    expect(await state.stepSimulation(60)).toBeNull();
    expect(fetchRealWorld).toHaveBeenCalledOnce();
    expect(state.isSimulationRunning).toBe(false);
    expect(state.simulation.error).toBeNull();
    expect(state.simulation.status).not.toBe('error');
  });
});

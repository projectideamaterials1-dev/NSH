// src/store/slices/simulation.ts
// Browser-driven simulation clock (paused in live mode, where the backend owns time).

import { apiJson } from '../../api/http';
import telemetryClient from '../../api/telemetryClient';
import { CONSTANTS } from '../frames';
import type { GetState, SetState, SimulationActions, SimulationStepResponse } from '../types';

export const createSimulationActions = (set: SetState, get: GetState): SimulationActions => ({
  stepSimulation: async (stepSeconds) => {
    if (get()._stepInFlight) return null; // never overlap steps
    set({ _stepInFlight: true });
    try {
      const result = await apiJson<SimulationStepResponse>('/api/simulate/step', {
        method: 'POST',
        body: JSON.stringify({ step_seconds: stepSeconds }),
      });
      set((state) => ({
        simulation: {
          ...state.simulation,
          stepsRun: state.simulation.stepsRun + 1,
          collisionsDetected: state.simulation.collisionsDetected + result.collisions_detected,
          maneuversExecuted: state.simulation.maneuversExecuted + result.maneuvers_executed,
          lastStepResponse: result,
          error: null,
        },
      }));
      // The stream pushes the new frame too; refreshing here makes the step feel immediate.
      await telemetryClient.refresh();
      if (result.maneuvers_executed > 0) await get().fetchManeuvers();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Step failed';
      get().setSimulationRunning(false);
      set((state) => ({ simulation: { ...state.simulation, status: 'error', error: message } }));
      return null;
    } finally {
      set({ _stepInFlight: false });
    }
  },

  setSimulationSpeed: (speed) => set({ simulationSpeed: speed }),

  setSimulationRunning: (isRunning) => {
    const { _simInterval } = get();
    if (_simInterval) clearInterval(_simInterval);
    let interval: ReturnType<typeof setInterval> | null = null;
    if (get().realWorld?.live) isRunning = false; // the backend owns the clock in live mode
    if (isRunning) {
      interval = setInterval(() => {
        get().stepSimulation(get().simulationSpeed * (CONSTANTS.SIM_TICK_MS / 1000));
      }, CONSTANTS.SIM_TICK_MS);
    }
    set((state) => ({
      _simInterval: interval,
      isSimulationRunning: isRunning,
      replayIndex: isRunning ? null : state.replayIndex,
      simulation: {
        ...state.simulation,
        status: isRunning ? 'running' : state.simulation.status === 'error' ? 'error' : 'paused',
        error: isRunning ? null : state.simulation.error,
      },
    }));
  },
});

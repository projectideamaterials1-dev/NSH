import { describe, expect, it } from 'vitest';
import { pushReplayFrame, toReplayFrame, selectOpenThreatCounts } from '../store/useOrbitalStore';
import type { Conjunction } from '../store/useOrbitalStore';
import { snapshotToBinaryBuffers } from '../store/snapshotBuffers';

const snapshot = (ts: string) => ({
  timestamp: ts,
  satellites: [{ id: 'SAT-1', lat: 10, lon: 20, fuel_kg: 49.5, status: 'NOMINAL' }, { id: 'SAT-2', lat: -5, lon: 170, fuel_kg: 2, status: 'CRITICAL_FUEL' }],
  debris_cloud: [['DEB-1', 1, 2, 500], ['DEB-2', 3, 4, 600]] as [string, number, number, number][],
});

describe('snapshot buffers', () => {
  it('packs lon/lat/alt and status colours', () => {
    const { satellites, debris } = snapshotToBinaryBuffers(snapshot('2026-01-01T00:00:00Z'));
    expect(Array.from(satellites.positions.slice(0, 2))).toEqual([20, 10]);
    expect(satellites.statuses).toEqual(['NOMINAL', 'CRITICAL_FUEL']);
    expect(Array.from(satellites.colors.slice(4, 8))).toEqual([255, 0, 51, 255]);
    expect(Array.from(debris.positions.slice(3, 6))).toEqual([4, 3, 600000]);
  });
});

describe('replay history', () => {
  const frame = (ts: string) => {
    const { satellites, debris } = snapshotToBinaryBuffers(snapshot(ts));
    return toReplayFrame(ts, satellites, debris);
  };

  it('stores 2D debris positions and skips duplicate timestamps', () => {
    const f = frame('2026-01-01T00:00:00Z');
    expect(Array.from(f.debrisPositions)).toEqual([2, 1, 4, 3]);
    let { history } = pushReplayFrame([], f, null, 3);
    ({ history } = pushReplayFrame(history, frame('2026-01-01T00:00:00Z'), null, 3));
    expect(history).toHaveLength(1);
  });

  it('caps history and keeps the replay cursor on the same frame', () => {
    let state = { history: [] as ReturnType<typeof frame>[], replayIndex: null as number | null };
    for (let i = 0; i < 3; i++) state = pushReplayFrame(state.history, frame(`2026-01-01T00:0${i}:00Z`), state.replayIndex, 3);
    state.replayIndex = 1;                                     // viewing 00:01
    state = pushReplayFrame(state.history, frame('2026-01-01T00:03:00Z'), state.replayIndex, 3);
    expect(state.history.map(f => f.timestamp.slice(14, 16))).toEqual(['01', '02', '03']);
    expect(state.history[state.replayIndex!].timestamp).toBe('2026-01-01T00:01:00Z');
  });
});

describe('threat counts selector', () => {
  it('counts only open conjunctions and is memoized', () => {
    const base = { satellite_id: 'S', object_id: 'D' } as Partial<Conjunction>;
    const conjunctions = [
      { ...base, cdm_id: '1', risk: 'CRITICAL', status: 'ACTIVE' },
      { ...base, cdm_id: '2', risk: 'WARNING', status: 'MITIGATED' },
      { ...base, cdm_id: '3', risk: 'CRITICAL', status: 'RESOLVED' },
      { ...base, cdm_id: '4', risk: 'WATCH', status: 'ACTIVE' },
    ] as Conjunction[];
    const state = { conjunctions } as any;
    const counts = selectOpenThreatCounts(state);
    expect(counts).toEqual({ CRITICAL: 1, WARNING: 1, WATCH: 1 });
    expect(selectOpenThreatCounts(state)).toBe(counts);        // stable reference (zustand v5 requirement)
  });
});

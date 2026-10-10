import { beforeEach, describe, expect, it } from 'vitest';
import { SHORTCUTS, isTypingTarget } from '../lib/shortcuts';
import useOrbitalStore, { selectPendingProposals, selectReplayFrame } from '../store/useOrbitalStore';
import type { Proposal, ReplayFrame } from '../store/useOrbitalStore';

const frame = (timestamp: string, predicted = false): ReplayFrame => ({
  timestamp, satIds: ['S'], satPositions: new Float32Array(3), satFuels: new Float32Array(1), satStatuses: ['NOMINAL'],
  debrisPositions: new Float32Array(0), debrisLength: 0, predicted,
});

describe('keyboard shortcuts', () => {
  it('has one action per key and covers the help entry', () => {
    const keys = SHORTCUTS.flatMap(s => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('?');
  });

  it('ignores key presses that belong to text fields', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'number' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('switches tabs and toggles overlays through the store', () => {
    const run = (key: string) => SHORTCUTS.find(s => s.keys.includes(key))!.run({ shiftKey: false } as KeyboardEvent);
    run('d');
    expect(useOrbitalStore.getState().rightTab).toBe('decisions');
    const before = useOrbitalStore.getState().showPerfHud;
    run('p');
    expect(useOrbitalStore.getState().showPerfHud).toBe(!before);
    run('2');
    expect(useOrbitalStore.getState().viewMode).toBe('2d');
  });
});

describe('time scrubbing state', () => {
  beforeEach(() => {
    useOrbitalStore.setState({
      history: [frame('2026-01-01T00:00:00Z'), frame('2026-01-01T00:01:00Z')],
      replayIndex: null, predictIndex: null,
      prediction: { start: '2026-01-01T00:01:00Z', step_s: 300, events: [], fetchedAt: Date.now(),
                    frames: [frame('2026-01-01T00:06:00Z', true), frame('2026-01-01T00:11:00Z', true)] },
    });
  });

  it('shows a predicted frame when scrubbing past now, and replay frames before it', () => {
    const s = useOrbitalStore.getState();
    expect(selectReplayFrame(s)).toBeNull();
    s.setPredictIndex(1);
    expect(selectReplayFrame(useOrbitalStore.getState())?.timestamp).toBe('2026-01-01T00:11:00Z');
    expect(selectReplayFrame(useOrbitalStore.getState())?.predicted).toBe(true);
    useOrbitalStore.getState().setReplayIndex(0);
    expect(useOrbitalStore.getState().predictIndex).toBeNull();
    expect(selectReplayFrame(useOrbitalStore.getState())?.timestamp).toBe('2026-01-01T00:00:00Z');
    useOrbitalStore.getState().setPredictIndex(99);
    expect(useOrbitalStore.getState().predictIndex).toBe(1);
  });

  it('lists only pending proposals', () => {
    const p = (id: string, status: Proposal['status']) => ({ proposal_id: id, status } as Proposal);
    useOrbitalStore.setState({ proposals: [p('a', 'PENDING'), p('b', 'APPROVED'), p('c', 'PENDING')] });
    expect(selectPendingProposals(useOrbitalStore.getState()).map(x => x.proposal_id)).toEqual(['a', 'c']);
  });
});

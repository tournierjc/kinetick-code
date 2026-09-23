import { describe, expect, it } from 'vitest';

import {
  TranscriptStore,
  UNSCOPED_TRANSCRIPT_SESSION,
} from '../../src/tui/transcript/store.js';
import type { TranscriptCellUpdate } from '../../src/tui/transcript/model.js';

function cell(id: string, content: string, turnId = 'turn-1'): TranscriptCellUpdate {
  return {
    id,
    kind: 'assistant',
    status: 'succeeded',
    content,
    turnId,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe('TranscriptStore session dimension', () => {
  it('keeps writes without a Session in the unscoped Session, like before', () => {
    const store = new TranscriptStore();

    store.upsert(cell('a', 'hello'));

    expect(store.activeSessionId).toBe(UNSCOPED_TRANSCRIPT_SESSION);
    expect(store.length).toBe(1);
    expect(store.cellAt(0)?.content).toBe('hello');
    expect(store.hasSession(UNSCOPED_TRANSCRIPT_SESSION)).toBe(true);
  });

  it('writes a named Session without disturbing the one on screen', () => {
    const store = new TranscriptStore();
    store.setActiveSession('session-a');
    store.upsert(cell('a1', 'A content'));

    store.upsert(cell('b1', 'B content'), 'session-b');

    expect(store.snapshot().map((entry) => entry.id)).toEqual(['a1']);
    expect(store.revision).toBe(2);

    store.setActiveSession('session-b');
    expect(store.snapshot().map((entry) => entry.content)).toEqual(['B content']);
  });

  it('keeps both Sessions when the active one changes', () => {
    const store = new TranscriptStore();
    store.setActiveSession('session-a');
    store.upsert(cell('a1', 'A'));
    store.setActiveSession('session-b');
    store.upsert(cell('b1', 'B'));

    store.setActiveSession('session-a');

    expect(store.length).toBe(1);
    expect(store.cellAt(0)?.content).toBe('A');
    expect(store.sessionIds()).toEqual(['session-a', 'session-b']);
    expect(store.hasSession('session-b')).toBe(true);
  });

  it('counts revisions per Session', () => {
    const store = new TranscriptStore();
    store.setActiveSession('session-a');
    store.upsert(cell('a1', 'A'));
    const aRevision = store.revision;
    expect(aRevision).toBe(2);

    store.upsert(cell('b1', 'B'), 'session-b');

    // A background write is not a change to the pane on screen.
    expect(store.revision).toBe(aRevision);
    store.setActiveSession('session-b');
    expect(store.revision).toBe(2);
  });

  it('keeps identical cell ids apart across Sessions', () => {
    const store = new TranscriptStore();
    store.upsert(cell('shared', 'A copy'), 'session-a');
    store.upsert(cell('shared', 'B copy'), 'session-b');

    store.setActiveSession('session-a');
    expect(store.get('shared')?.content).toBe('A copy');
    expect(store.length).toBe(1);
    store.setActiveSession('session-b');
    expect(store.get('shared')?.content).toBe('B copy');
  });

  it('clears and drops one Session at a time', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a1', 'A'), 'session-a');
    store.upsert(cell('b1', 'B'), 'session-b');

    store.clear('session-b');
    expect(store.hasSession('session-b')).toBe(true);
    store.setActiveSession('session-b');
    expect(store.length).toBe(0);
    store.setActiveSession('session-a');
    expect(store.length).toBe(1);

    expect(store.dropSession('session-b')).toBe(true);
    expect(store.dropSession('session-b')).toBe(false);
    expect(store.hasSession('session-b')).toBe(false);
    expect(store.hasSession('session-a')).toBe(true);
  });

  it('queues and flushes text deltas per Session', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a1', 'A'), 'session-a');
    store.upsert(cell('b1', 'B'), 'session-b');

    store.queueTextDelta('b1', ' more', 'session-b');
    store.queueTextDelta('a1', ' on screen', 'session-a');

    expect(store.flushTextDeltas(5, 'session-b')).toEqual(['b1']);
    store.setActiveSession('session-b');
    expect(store.cellAt(0)?.content).toBe('B more');
    expect(store.cellAt(0)?.updatedAtMs).toBe(5);

    expect(store.flushTextDeltas(6, 'session-a')).toEqual(['a1']);
    store.setActiveSession('session-a');
    expect(store.cellAt(0)?.content).toBe('A on screen');
  });

  it('refuses a delta for a cell of another Session', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a1', 'A'), 'session-a');

    expect(() => store.queueTextDelta('a1', 'x', 'session-b')).toThrow(
      'Cannot queue transcript delta for unknown cell: a1',
    );
  });

  it('replaces the durable projection of one Session and keeps its ephemeral cells', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a-durable', 'durable A'), 'session-a');
    store.upsert({ ...cell('a-local', 'local note'), ephemeral: true }, 'session-a');
    store.upsert(cell('b-durable', 'durable B'), 'session-b');

    store.replaceDurableProjection(() => {
      store.upsert(cell('a-durable', 'durable A re-projected'), 'session-a');
    }, 'session-a');

    store.setActiveSession('session-a');
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['a-durable', 'a-local']);
    expect(store.cellAt(0)?.content).toBe('durable A re-projected');
    expect(store.cellAt(1)?.content).toBe('local note');

    // The other Session is untouched.
    store.setActiveSession('session-b');
    expect(store.snapshot().map((entry) => entry.content)).toEqual(['durable B']);
  });

  it('locates cells and turn ranges per Session', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a1', 'A1', 'turn-a'), 'session-a');
    store.upsert(cell('a2', 'A2', 'turn-b'), 'session-a');
    store.upsert(cell('b1', 'B1', 'turn-b'), 'session-b');

    expect(store.locateCell('b1')).toBeUndefined();
    expect(store.turnCount).toBe(0);

    store.setActiveSession('session-a');
    expect(store.locateCell('a2')).toEqual({ index: 1, turnIndex: 1 });
    expect(store.turnRange(0)).toEqual({ start: 0, end: 1 });
    expect(store.turnRange(1)).toEqual({ start: 1, end: 2 });
    expect(store.turnCount).toBe(2);
  });

  it('removes and moves cells inside one Session only', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a1', 'A1', 'turn-a'), 'session-a');
    store.upsert(cell('a2', 'A2', 'turn-b'), 'session-a');
    store.upsert(cell('b1', 'B1', 'turn-a'), 'session-b');
    store.upsert(cell('b2', 'B2', 'turn-b'), 'session-b');

    expect(store.remove('b1', 'session-b')).toBe(true);
    store.setActiveSession('session-b');
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['b2']);

    store.setActiveSession('session-a');
    expect(store.moveToEnd('a1', 'session-a')).toBe(true);
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['a2', 'a1']);
    expect(store.remove('b1')).toBe(false);
  });

  it('keeps a running turn’s cells when durable content is re-projected', () => {
    const store = new TranscriptStore();
    store.upsert(cell('settled', 'old answer', 'turn-1'), 'session-a');
    store.upsert(
      { ...cell('live', 'streaming tail', 'turn-2'), status: 'running' },
      'session-a',
    );

    store.replaceDurableProjection(() => {
      store.upsert(cell('settled', 'durable answer', 'turn-1'), 'session-a');
      store.upsert(cell('durable-2', 'durable tail', 'turn-2'), 'session-a');
    }, 'session-a');

    // The settled cell is replaced by its durable twin, the running one is kept:
    // its content is not durable yet, so re-projecting would lose it.
    store.setActiveSession('session-a');
    expect(store.snapshot().map((entry) => entry.id)).toEqual(['settled', 'live', 'durable-2']);
    expect(store.get('settled')?.content).toBe('durable answer');
    expect(store.get('live')?.content).toBe('streaming tail');
  });

  it('moves a Session’s cells to another Session', () => {
    const store = new TranscriptStore();
    store.upsert(cell('a1', 'A1'));
    store.upsert(cell('a2', 'A2'));

    expect(store.moveSession(UNSCOPED_TRANSCRIPT_SESSION, 'session-a')).toBe(true);

    expect(store.hasSession(UNSCOPED_TRANSCRIPT_SESSION)).toBe(false);
    expect(store.activeSessionId).toBe('session-a');
    expect(store.snapshot().map((entry) => entry.content)).toEqual(['A1', 'A2']);
  });

  it('ignores a move that has nothing to move', () => {
    const store = new TranscriptStore();

    expect(store.moveSession('session-a', 'session-a')).toBe(false);
    expect(store.moveSession('session-a', 'session-b')).toBe(false);
  });

  it('writes through a Session-scoped projection target', () => {
    const store = new TranscriptStore();
    store.setActiveSession('session-a');
    store.upsert(cell('a1', 'A on screen'));

    const scoped = store.scoped('session-b');
    scoped.upsert(cell('b1', 'B from a background turn'));
    scoped.queueTextDelta('b1', ' and more');
    expect(scoped.flushTextDeltas(7)).toEqual(['b1']);

    // The pane on screen is untouched, and the target reads its own Session.
    expect(store.snapshot().map((entry) => entry.content)).toEqual(['A on screen']);
    expect(store.get('b1')).toBeUndefined();
    expect(scoped.snapshot().map((entry) => entry.content)).toEqual([
      'B from a background turn and more',
    ]);
    expect(scoped.get('a1')).toBeUndefined();
    expect(scoped.get('b1')?.updatedAtMs).toBe(7);
  });

  it('keeps two scoped targets apart even for the same cell id', () => {
    const store = new TranscriptStore();
    const scopedA = store.scoped('session-a');
    const scopedB = store.scoped('session-b');

    scopedA.upsert(cell('turn-1', 'A copy'));
    scopedB.upsert(cell('turn-1', 'B copy'));

    expect(scopedA.snapshot().map((entry) => entry.content)).toEqual(['A copy']);
    expect(scopedB.snapshot().map((entry) => entry.content)).toEqual(['B copy']);
    expect(scopedA.remove('turn-1')).toBe(true);
    expect(scopedB.snapshot().map((entry) => entry.content)).toEqual(['B copy']);
  });

  it('reports activity from the active Session only', () => {
    const store = new TranscriptStore();
    store.upsert(
      { ...cell('a1', 'working', 'turn-a'), status: 'running', kind: 'tool' },
      'session-a',
    );
    store.upsert(
      { ...cell('b1', 'B error', 'turn-b'), kind: 'error', status: 'failed' },
      'session-b',
    );

    store.setActiveSession('session-a');
    expect(store.hasConcreteTurnActivity('turn-a')).toBe(true);
    expect(store.findVisibleError('B error')).toBeUndefined();

    store.setActiveSession('session-b');
    expect(store.hasConcreteTurnActivity('turn-a')).toBe(false);
    expect(store.findVisibleError('B error')).toEqual({ turnId: 'turn-b' });
  });
});

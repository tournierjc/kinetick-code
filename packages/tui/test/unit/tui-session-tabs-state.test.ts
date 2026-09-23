import { describe, expect, it } from 'vitest';
import { createTuiState } from '../../src/tui/state/model.js';
import { reduceTuiState } from '../../src/tui/state/reducer.js';
import {
  cycleTuiTab,
  selectTuiTabAfterClose,
  selectTuiTabSlot,
  TUI_TAB_DIRECT_SLOT_COUNT,
} from '../../src/tui/state/tabs.js';
import type { TuiAction } from '../../src/tui/state/actions.js';
import type { TuiState } from '../../src/tui/state/model.js';

function apply(state: TuiState, ...actions: readonly TuiAction[]): TuiState {
  return actions.reduce((current, action) => reduceTuiState(current, action).state, state);
}

function activate(sessionId: string): TuiAction {
  return { type: 'session/activate', sessionId };
}

function settleTurn(sessionId: string, turnId: string): readonly TuiAction[] {
  return [
    {
      type: 'execution/runObserved',
      sessionId,
      run: { runId: turnId, turnId, status: 'running' },
    },
    {
      type: 'execution/runObserved',
      sessionId,
      run: { runId: turnId, turnId, status: 'terminal' },
    },
  ];
}

describe('session tab list', () => {
  it('opens a tab for every activated Session, in activation order', () => {
    const state = apply(createTuiState(), activate('session-a'), activate('session-b'));

    expect(state.tabs.order).toEqual(['session-a', 'session-b']);
    expect(state.activeSessionId).toBe('session-b');
  });

  it('keeps one tab per Session when the same Session is activated again', () => {
    const state = apply(
      createTuiState(),
      activate('session-a'),
      activate('session-b'),
      activate('session-a'),
    );

    expect(state.tabs.order).toEqual(['session-a', 'session-b']);
    expect(state.activeSessionId).toBe('session-a');
  });

  it('does not add a tab when the Session is cleared', () => {
    const state = apply(createTuiState(), activate('session-a'), { type: 'session/activate' });

    expect(state.activeSessionId).toBeUndefined();
    expect(state.tabs.order).toEqual(['session-a']);
  });

  it('opens a background tab without making it visible', () => {
    const state = apply(createTuiState(), activate('session-a'), {
      type: 'tabs/open',
      sessionId: 'session-b',
    });

    expect(state.tabs.order).toEqual(['session-a', 'session-b']);
    expect(state.activeSessionId).toBe('session-a');
  });

  it('closes a background tab without reordering the survivors', () => {
    const state = apply(
      createTuiState(),
      activate('session-a'),
      activate('session-b'),
      activate('session-c'),
      { type: 'tabs/close', sessionId: 'session-b' },
    );

    expect(state.tabs.order).toEqual(['session-a', 'session-c']);
    expect(state.activeSessionId).toBe('session-c');
  });

  it('never closes the visible tab', () => {
    const opened = apply(createTuiState(), activate('session-a'), activate('session-b'));
    const state = apply(opened, { type: 'tabs/close', sessionId: 'session-b' });

    expect(state.tabs.order).toEqual(['session-a', 'session-b']);
    expect(state.activeSessionId).toBe('session-b');
  });

  it('returns the same state object when a tab action changes nothing', () => {
    const opened = apply(createTuiState(), activate('session-a'));

    expect(reduceTuiState(opened, { type: 'tabs/open', sessionId: 'session-a' }).state).toBe(opened);
    expect(reduceTuiState(opened, { type: 'tabs/close', sessionId: 'session-missing' }).state).toBe(
      opened,
    );
  });

  it('keeps every tab it opened while Sessions are unknown', () => {
    const opened = apply(createTuiState(), activate('session-a'), activate('session-b'));

    expect(opened.tabs.order).toEqual(['session-a', 'session-b']);
  });

  it('counts finished turns per background tab and clears them on activation', () => {
    const base = apply(createTuiState(), activate('session-a'), activate('session-b'), activate('session-a'));
    const afterBackgroundTurn = apply(base, ...settleTurn('session-b', 'turn-1'));
    const afterSecondTurn = apply(afterBackgroundTurn, ...settleTurn('session-b', 'turn-2'));

    expect(afterSecondTurn.sessions.get('session-b')?.attention.unread).toBe(2);
    expect(afterSecondTurn.sessions.get('session-a')?.attention.unread).toBe(0);

    const reopened = apply(afterSecondTurn, activate('session-b'));
    expect(reopened.sessions.get('session-b')?.attention.unread).toBe(0);
  });

  it('never counts turns of the visible tab as unread', () => {
    const state = apply(createTuiState(), activate('session-a'), ...settleTurn('session-a', 'turn-1'));

    expect(state.sessions.get('session-a')?.attention.unread).toBe(0);
  });

  it('keeps the visible Session open through every tab action', () => {
    let state = apply(createTuiState(), activate('session-a'), activate('session-b'));
    for (const action of [
      { type: 'tabs/open', sessionId: 'session-c' },
      { type: 'tabs/close', sessionId: 'session-a' },
      { type: 'tabs/close', sessionId: 'session-b' },
    ] satisfies readonly TuiAction[]) {
      state = apply(state, action);
      expect(state.activeSessionId && state.tabs.order.includes(state.activeSessionId)).toBe(true);
    }
  });
});

describe('tab navigation helpers', () => {
  it('selects the next tab as the neighbour when a middle tab closes', () => {
    expect(selectTuiTabAfterClose(['a', 'b', 'c'], 'b')).toBe('c');
  });

  it('falls back to the previous tab when the last tab closes', () => {
    expect(selectTuiTabAfterClose(['a', 'b', 'c'], 'c')).toBe('b');
  });

  it('reports no neighbour for the only tab', () => {
    expect(selectTuiTabAfterClose(['a'], 'a')).toBeUndefined();
    expect(selectTuiTabAfterClose(['a'], 'missing')).toBeUndefined();
  });

  it('cycles forward and backward with wraparound', () => {
    expect(cycleTuiTab(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(cycleTuiTab(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(cycleTuiTab(['a', 'b', 'c'], undefined, 1)).toBe('a');
    expect(cycleTuiTab(['a', 'b', 'c'], undefined, -1)).toBe('c');
    expect(cycleTuiTab([], 'a', 1)).toBeUndefined();
  });

  it('maps direct slots to the first tabs only', () => {
    const order = Array.from({ length: TUI_TAB_DIRECT_SLOT_COUNT + 2 }, (_, index) => `s${index}`);

    expect(selectTuiTabSlot(order, 1)).toBe('s0');
    expect(selectTuiTabSlot(order, TUI_TAB_DIRECT_SLOT_COUNT)).toBe(`s${TUI_TAB_DIRECT_SLOT_COUNT - 1}`);
    expect(selectTuiTabSlot(order, TUI_TAB_DIRECT_SLOT_COUNT + 1)).toBeUndefined();
    expect(selectTuiTabSlot(order, 0)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { createTuiState } from '../../src/tui/state/model.js';
import { reduceTuiState } from '../../src/tui/state/reducer.js';
import {
  applyingTuiTabGroupCollapse,
  foldingTuiTabGroups,
  cycleTuiTab,
  moveTuiTab,
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

  it('moves a tab by state action without switching the visible Session', () => {
    const opened = apply(
      createTuiState(),
      activate('session-a'),
      activate('session-b'),
      activate('session-c'),
    );

    const state = apply(opened, { type: 'tabs/move', sessionId: 'session-a', delta: 1 });

    expect(state.tabs.order).toEqual(['session-b', 'session-a', 'session-c']);
    expect(state.activeSessionId).toBe('session-c');
  });

  it('returns the same state object when a move cannot happen', () => {
    const opened = apply(createTuiState(), activate('session-a'), activate('session-b'));

    expect(
      reduceTuiState(opened, { type: 'tabs/move', sessionId: 'session-a', delta: -1 }).state,
    ).toBe(opened);
    expect(
      reduceTuiState(opened, { type: 'tabs/move', sessionId: 'session-b', delta: 1 }).state,
    ).toBe(opened);
    expect(
      reduceTuiState(opened, { type: 'tabs/move', sessionId: 'session-missing', delta: 1 }).state,
    ).toBe(opened);
  });

  it('swaps the Session a tab shows without moving the tab', () => {
    const opened = apply(
      createTuiState(),
      activate('session-a'),
      activate('session-b'),
      activate('session-c'),
    );

    const state = apply(opened, {
      type: 'tabs/replace',
      sessionId: 'session-b',
      replacementId: 'session-d',
    });

    // The bar keeps its length and the replaced tab keeps its position, so the new
    // Session inherits its direct slot; visibility stays where it was.
    expect(state.tabs.order).toEqual(['session-a', 'session-d', 'session-c']);
    expect(state.activeSessionId).toBe('session-c');
  });

  it('keeps one slot for the replacement when it was already open', () => {
    const opened = apply(
      createTuiState(),
      activate('session-a'),
      activate('session-b'),
      activate('session-c'),
    );

    const state = apply(opened, {
      type: 'tabs/replace',
      sessionId: 'session-c',
      replacementId: 'session-a',
    });

    expect(state.tabs.order).toEqual(['session-b', 'session-a']);
  });

  it('returns the same state object when there is nothing to replace', () => {
    const opened = apply(createTuiState(), activate('session-a'));

    expect(
      reduceTuiState(opened, {
        type: 'tabs/replace',
        sessionId: 'session-missing',
        replacementId: 'session-d',
      }).state,
    ).toBe(opened);
    expect(
      reduceTuiState(opened, {
        type: 'tabs/replace',
        sessionId: 'session-a',
        replacementId: 'session-a',
      }).state,
    ).toBe(opened);
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

describe('tab grouping state', () => {
  it('starts grouped and keeps the open tabs when grouping turns off', () => {
    const state = apply(createTuiState(), activate('a'), activate('b'));

    expect(state.tabs.grouped).toBe(true);

    const flat = apply(state, { type: 'tabs/toggleGrouping', grouped: false });

    expect(flat.tabs.grouped).toBe(false);
    expect(flat.tabs.order).toEqual(['a', 'b']);
  });

  it('does not report a change when grouping already has the requested value', () => {
    const state = createTuiState();

    expect(reduceTuiState(state, { type: 'tabs/toggleGrouping', grouped: true }).state).toBe(state);
  });

  it('folds and unfolds a group, and keeps folding across tab changes', () => {
    const state = apply(createTuiState(), activate('a'), activate('b'));
    const folded = apply(state, { type: 'tabs/toggleGroup', groupKey: '/work/api' });

    expect(folded.tabs.collapsedGroups).toEqual(['/work/api']);
    expect(apply(folded, { type: 'tabs/toggleGroup', groupKey: '/work/api' }).tabs.collapsedGroups)
      .toEqual([]);

    const reopened = apply(folded, { type: 'tabs/toggleGroup', groupKey: '/work/web' });
    expect(reopened.tabs.collapsedGroups).toEqual(['/work/api', '/work/web']);
    expect(reopened.tabs.order).toEqual(['a', 'b']);
  });

  it('applies folding, except to the group holding the visible Session', () => {
    expect(applyingTuiTabGroupCollapse(['/work/api', '/work/web'], '/work/api')).toEqual([
      '/work/web',
    ]);
    expect(applyingTuiTabGroupCollapse(['/work/api'], undefined)).toEqual(['/work/api']);
    expect(applyingTuiTabGroupCollapse([], '/work/api')).toEqual([]);
  });

  it('folds every group but the visible one, and unfolds them all again', () => {
    const keys = ['/work/api', '/work/web'];

    expect(foldingTuiTabGroups(keys, '/work/api', [])).toEqual(['/work/web']);
    expect(foldingTuiTabGroups(keys, '/work/api', ['/work/web'])).toEqual([]);
    expect(foldingTuiTabGroups(keys, '/work/web', ['/work/api'])).toEqual([]);
  });

  it('leaves folding alone when there is nothing to fold', () => {
    const collapsed = ['/work/web'];

    // Identity, not equality: the caller uses it to tell "no change" from "unfold".
    expect(foldingTuiTabGroups(['/work/api'], '/work/api', collapsed)).toBe(collapsed);
    expect(foldingTuiTabGroups(['/work/api', '/work/web'], undefined, collapsed)).toBe(collapsed);
    expect(foldingTuiTabGroups([], '/work/api', collapsed)).toBe(collapsed);
  });

  it('sets the folded groups in one action', () => {
    const state = createTuiState();

    const folded = reduceTuiState(state, {
      type: 'tabs/setCollapsedGroups',
      groupKeys: ['/work/api'],
    }).state;

    expect(folded.tabs.collapsedGroups).toEqual(['/work/api']);

    const unfolded = reduceTuiState(folded, {
      type: 'tabs/setCollapsedGroups',
      groupKeys: [],
    }).state;

    expect(unfolded.tabs.collapsedGroups).toEqual([]);
  });
});

describe('moveTuiTab', () => {
  it('swaps a tab with its neighbour and leaves every other tab where it is', () => {
    expect(moveTuiTab(['a', 'b', 'c', 'd'], 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveTuiTab(['a', 'b', 'c', 'd'], 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('clamps at both ends instead of wrapping', () => {
    const order = ['a', 'b', 'c'];

    expect(moveTuiTab(order, 'a', -1)).toBe(order);
    expect(moveTuiTab(order, 'c', 1)).toBe(order);
  });

  it('returns the same list for a no-op move', () => {
    const order = ['a', 'b'];

    expect(moveTuiTab(order, 'a', 0)).toBe(order);
    expect(moveTuiTab(order, 'missing', 1)).toBe(order);
    expect(moveTuiTab([], 'a', 1)).toEqual([]);
  });

  it('takes the whole delta, so a jump across the bar is one move', () => {
    expect(moveTuiTab(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(moveTuiTab(['a', 'b', 'c'], 'c', -2)).toEqual(['c', 'a', 'b']);
    // Past the end the clamp still applies.
    const order = ['a', 'b', 'c'];
    expect(moveTuiTab(order, 'a', 9)).toBe(order);
  });
});

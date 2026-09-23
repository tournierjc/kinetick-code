import { describe, expect, it, vi } from 'vitest';

import { TuiSessionFlow } from '../../../src/tui/controller/session-flow.js';
import { createTuiState } from '../../../src/tui/state/model.js';
import { reduceTuiState } from '../../../src/tui/state/reducer.js';
import type { TuiAction } from '../../../src/tui/state/actions.js';
import type { TuiSession } from '../../../src/runtime/port.js';

const TAB_A = 'sess-a';
const TAB_B = 'sess-b';
const TAB_C = 'sess-c';

/**
 * A store double that runs the real tab reducer, so these tests exercise the
 * interaction between the flow and the tab-list invariants (the visible Session
 * is always an open tab) instead of a stand-in rule.
 */
function createFlow(options: { tabs: readonly string[]; visible: string; hasLiveRun?: boolean }) {
  let state = createTuiState();
  for (const sessionId of options.tabs) {
    state = reduceTuiState(state, { type: 'session/activate', sessionId }).state;
  }
  let visible: string | undefined = options.visible;
  state = reduceTuiState(
    state,
    options.visible ? { type: 'session/activate', sessionId: options.visible } : { type: 'session/activate' },
  ).state;

  const sessions = new Map<string, TuiSession>(
    [...options.tabs, 'sess-new'].map((sessionId) => [sessionId, { sessionId } as TuiSession]),
  );
  const dispatch = vi.fn((action: TuiAction) => {
    state = reduceTuiState(state, action).state;
    return [];
  });
  const startNewSession = vi.fn((markSessionCleared?: boolean) => {
    void markSessionCleared;
    visible = undefined;
  });
  const loadSessionProjection = vi.fn(async (sessionId: string) => {
    visible = sessionId;
    // Mirrors app.ts: the controller reports the opened Session, and the shell
    // turns that into the state activation that opens the tab.
    state = reduceTuiState(state, { type: 'session/activate', sessionId }).state;
  });
  const append = vi.fn();
  const listSessionPage = vi.fn(async () => ({ sessions: [], hasMore: false }));

  const flow = new TuiSessionFlow({
    runtime: {
      listSessionPage,
      getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? { sessionId }),
      createSession: vi.fn(async () => sessions.get('sess-new') as TuiSession),
      deleteSession: vi.fn(async () => undefined),
      getActiveRun: vi.fn(async (sessionId: string) => ({
        schemaVersion: 1 as const,
        sessionId,
        state: 'terminal' as const,
        actions: { steer: false },
      })),
    } as never,
    controller: {
      snapshot: vi.fn(() => ({
        session: visible ? (sessions.get(visible) ?? { sessionId: visible }) : undefined,
        sessions: [...sessions.values()],
      })),
      loadSessionProjection,
      startNewSession,
      whenIdle: vi.fn(async () => undefined),
      refreshSessionList: vi.fn(async () => undefined),
    } as never,
    stateStore: { snapshot: () => state, dispatch } as never,
    composerDraft: { discard: vi.fn(async () => undefined) } as never,
    interactionFlow: { deactivate: vi.fn(), recover: vi.fn(async () => undefined) } as never,
    featureFlow: {
      resetSessionState: vi.fn(),
      refreshSelectedModel: vi.fn(async () => undefined),
    } as never,
    queueFlow: { reset: vi.fn(), refresh: vi.fn(async () => []) } as never,
    delegationFlow: { reset: vi.fn(), refresh: vi.fn(async () => undefined) } as never,
    activeRunFlow: { refresh: vi.fn(async () => undefined) },
    runProjection: { markRecoveredTurn: vi.fn() } as never,
    append,
    onChanged: vi.fn(),
    requestWelcomeRebuild: vi.fn(),
    hasLiveRun: () => options.hasLiveRun === true,
    currentRunId: () => (options.hasLiveRun ? 'turn-live' : undefined),
  });

  return {
    flow,
    append,
    dispatch,
    loadSessionProjection,
    startNewSession,
    tabOrder: () => state.tabs.order,
    activeSessionId: () => state.activeSessionId,
  };
}

describe('cycleTab', () => {
  it('activates the next tab and keeps every tab open', async () => {
    const { flow, loadSessionProjection, tabOrder, activeSessionId } = createFlow({
      tabs: [TAB_A, TAB_B, TAB_C],
      visible: TAB_A,
    });

    await flow.cycleTab(1);

    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_B);
    expect(activeSessionId()).toBe(TAB_B);
    expect(tabOrder()).toEqual([TAB_A, TAB_B, TAB_C]);
  });

  it('wraps to the last tab when cycling backwards from the first', async () => {
    const { flow, loadSessionProjection } = createFlow({ tabs: [TAB_A, TAB_B], visible: TAB_A });

    await flow.cycleTab(-1);

    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_B);
  });

  it('reports a hint instead of switching when one tab is open', async () => {
    const { flow, append, loadSessionProjection } = createFlow({ tabs: [TAB_A], visible: TAB_A });

    await flow.cycleTab(1);

    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      'Only one Session tab is open. Use /sessions to open another.',
      'warning',
    );
  });

  it('refuses to switch while a turn is live', async () => {
    const { flow, append, loadSessionProjection } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      hasLiveRun: true,
    });

    await flow.cycleTab(1);

    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith('Stop the running turn before using /sessions.', 'warning');
  });
});

describe('activateTabSlot', () => {
  it('activates the Session bound to a direct slot', async () => {
    const { flow, loadSessionProjection } = createFlow({
      tabs: [TAB_A, TAB_B, TAB_C],
      visible: TAB_A,
    });

    await flow.activateTabSlot(3);

    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_C);
  });

  it('does nothing when the slot is empty', async () => {
    const { flow, append, loadSessionProjection } = createFlow({ tabs: [TAB_A], visible: TAB_A });

    await flow.activateTabSlot(4);

    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith('No open Session tab in slot 4.', 'warning');
  });

  it('skips the switch when the slot is already visible', async () => {
    const { flow, loadSessionProjection } = createFlow({ tabs: [TAB_A, TAB_B], visible: TAB_B });

    await flow.activateTabSlot(2);

    expect(loadSessionProjection).not.toHaveBeenCalled();
  });
});

describe('closeTab', () => {
  it('activates the next tab before closing the visible one', async () => {
    const { flow, loadSessionProjection, tabOrder, activeSessionId } = createFlow({
      tabs: [TAB_A, TAB_B, TAB_C],
      visible: TAB_B,
    });

    await flow.closeTab();

    // The neighbour is shown first, so the closed tab is no longer the visible
    // one when the tab list drops it.
    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_C);
    expect(activeSessionId()).toBe(TAB_C);
    expect(tabOrder()).toEqual([TAB_A, TAB_C]);
  });

  it('falls back to the previous tab when the last tab closes', async () => {
    const { flow, tabOrder, activeSessionId } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_B,
    });

    await flow.closeTab();

    expect(activeSessionId()).toBe(TAB_A);
    expect(tabOrder()).toEqual([TAB_A]);
  });

  it('starts a new Session when the last tab closes', async () => {
    const { flow, startNewSession, tabOrder, activeSessionId } = createFlow({
      tabs: [TAB_A],
      visible: TAB_A,
    });

    await flow.closeTab();

    expect(startNewSession).toHaveBeenCalled();
    expect(activeSessionId()).toBeUndefined();
    expect(tabOrder()).toEqual([]);
  });

  it('keeps the tab when the switch is refused by a live turn', async () => {
    const { flow, append, tabOrder, activeSessionId } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      hasLiveRun: true,
    });

    await flow.closeTab();

    expect(append).toHaveBeenCalledWith('Stop the running turn before using /sessions.', 'warning');
    expect(tabOrder()).toEqual([TAB_A, TAB_B]);
    expect(activeSessionId()).toBe(TAB_A);
  });
});

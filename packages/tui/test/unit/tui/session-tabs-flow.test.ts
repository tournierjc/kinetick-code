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
function createFlow(options: {
  tabs: readonly string[];
  visible: string;
  hasLiveRun?: boolean;
  /** Workspace directory per Session, so the tab bar can group by project. */
  projects?: Readonly<Record<string, string>>;
}) {
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
    [...options.tabs, 'sess-new'].map((sessionId) => [
      sessionId,
      {
        sessionId,
        title: sessionId,
        ...(options.projects?.[sessionId] ? { workspaceDir: options.projects[sessionId] } : {}),
      } as TuiSession,
    ]),
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
  const renameSession = vi.fn(async (sessionId: string, title: string) => ({
    sessionId,
    title,
  }) as TuiSession);
  const showSessionManager = vi.fn(async () => undefined);

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
      renameSession,
      whenIdle: vi.fn(async () => undefined),
      refreshSessionList: vi.fn(async () => undefined),
    } as never,
    stateStore: { snapshot: () => state, dispatch } as never,
    composerDraft: { discard: vi.fn(async () => undefined) } as never,
    interactionFlow: { deactivate: vi.fn(), recover: vi.fn(async () => undefined) } as never,
    featureFlow: {
      resetSessionState: vi.fn(),
      refreshSelectedModel: vi.fn(async () => undefined),
      showSessionManager,
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
    renameSession,
    showSessionManager,
    tabOrder: () => state.tabs.order,
    activeSessionId: () => state.activeSessionId,
    tabs: () => state.tabs,
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

  it('switches while a turn is live and says the turn keeps running', async () => {
    const { flow, append, loadSessionProjection } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      hasLiveRun: true,
    });

    await flow.cycleTab(1);

    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_B);
    expect(append).toHaveBeenCalledWith(
      'The previous Session keeps running in the background; switch back to its tab to watch it.',
    );
  });
});

describe('activateTabSlot', () => {
  it('switches to another tab while a turn is live', async () => {
    const { flow, loadSessionProjection, append } = createFlow({
      tabs: [TAB_A, TAB_B, TAB_C],
      visible: TAB_A,
      hasLiveRun: true,
    });

    await flow.activateTabSlot(2);

    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_B);
    expect(append).toHaveBeenCalledWith(
      'The previous Session keeps running in the background; switch back to its tab to watch it.',
    );
  });

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

  it('keeps the running tab open instead of closing it', async () => {
    const { flow, append, tabOrder, activeSessionId } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      hasLiveRun: true,
    });

    await flow.closeTab();

    expect(append).toHaveBeenCalledWith('Stop the running turn before closing its tab.', 'warning');
    expect(tabOrder()).toEqual([TAB_A, TAB_B]);
    expect(activeSessionId()).toBe(TAB_A);
  });
});

describe('renameTab', () => {
  it('renames the visible Session and reports the new title', async () => {
    const { flow, renameSession, append } = createFlow({ tabs: [TAB_A, TAB_B], visible: TAB_B });

    await flow.renameTab('  Release checklist  ');

    expect(renameSession).toHaveBeenCalledWith(TAB_B, 'Release checklist');
    expect(append).toHaveBeenCalledWith('Session renamed to “Release checklist”.');
  });

  it('opens the rename field when no title is given', async () => {
    const { flow, showSessionManager, renameSession } = createFlow({
      tabs: [TAB_A],
      visible: TAB_A,
    });

    await flow.renameTab();

    expect(showSessionManager).toHaveBeenCalledWith('', { initialRenameSessionId: TAB_A });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it('asks for a Session instead of renaming nothing', async () => {
    const { flow, append, renameSession, showSessionManager } = createFlow({
      tabs: [],
      visible: '',
    });

    await flow.renameTab('Anything');

    expect(renameSession).not.toHaveBeenCalled();
    expect(showSessionManager).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      'Start or resume a Session before renaming its tab.',
      'warning',
    );
  });
});

describe('tab grouping', () => {
  const projects = { [TAB_A]: '/work/api', [TAB_B]: '/work/web' };

  it('turns grouping off and on without closing tabs', async () => {
    const { flow, tabs, tabOrder } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      projects,
    });

    expect(tabs().grouped).toBe(true);

    await flow.setTabGrouping(false);
    expect(tabs().grouped).toBe(false);
    expect(tabOrder()).toEqual([TAB_A, TAB_B]);

    await flow.setTabGrouping(true);
    expect(tabs().grouped).toBe(true);
  });

  it('says so when every open tab is in the same project', async () => {
    const { flow, append, tabs } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      projects: { [TAB_A]: '/work/api', [TAB_B]: '/work/api' },
    });

    await flow.setTabGrouping(false);
    append.mockClear();
    await flow.setTabGrouping(true);

    expect(tabs().grouped).toBe(true);
    expect(append).toHaveBeenCalledWith('Grouping needs tabs from more than one project.');
  });

  it('folds every other tab group and explains that the visible one stays open', async () => {
    const { flow, tabs, append } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_B,
      projects,
    });

    await flow.toggleTabGroupCollapse();

    expect(tabs().collapsedGroups).toEqual(['/work/api']);
    expect(append).toHaveBeenCalledWith(
      'web holds the visible tab, so it stays open; the other project groups are folded.',
    );

    await flow.toggleTabGroupCollapse();

    expect(tabs().collapsedGroups).toEqual([]);
    expect(append).toHaveBeenLastCalledWith('Showing every project group again.');
  });

  it('folds nothing when every open tab belongs to the same project', async () => {
    const { flow, tabs, append } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      projects: { [TAB_A]: '/work/api', [TAB_B]: '/work/api' },
    });

    await flow.toggleTabGroupCollapse();

    expect(tabs().collapsedGroups).toEqual([]);
    expect(append).toHaveBeenCalledWith(
      'Only one project group is open, so there is nothing to fold.',
      'warning',
    );
  });

  it('refuses to fold while grouping is off', async () => {
    const { flow, append, tabs } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      projects,
    });

    await flow.setTabGrouping(false);
    append.mockClear();
    await flow.toggleTabGroupCollapse();

    expect(tabs().collapsedGroups).toEqual([]);
    expect(append).toHaveBeenCalledWith(
      'Project grouping is off. Turn it on with /tabs group on.',
      'warning',
    );
  });

  it('keeps a folded group reachable by cycling', async () => {
    const { flow, tabs, loadSessionProjection } = createFlow({
      tabs: [TAB_A, TAB_B],
      visible: TAB_A,
      projects,
    });

    await flow.toggleTabGroupCollapse();
    expect(tabs().collapsedGroups).toEqual(['/work/web']);

    await flow.cycleTab(1);

    expect(loadSessionProjection).toHaveBeenCalledWith(TAB_B);
  });
});

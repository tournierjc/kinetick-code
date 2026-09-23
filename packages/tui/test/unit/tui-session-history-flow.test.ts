import { describe, expect, it, vi } from 'vitest';

import { TuiMainScreen } from '../../src/tui/engine/tui-main-screen.js';
import { TuiOverlayRegularFeaturePresenter } from '../../src/tui/shell/regular-feature-presenter.js';
import { TuiSurfaceHost, type TuiFeatureScreen } from '../../src/tui/shell/surface-host.js';
import { VirtualTerminal } from '../pi-084-upstream/virtual-terminal.js';

import type { TuiSessionForkOptions, TuiSessionInputSummary } from '../../src/runtime/port.js';
import { TuiSessionMutationFlow } from '../../src/tui/controller/product/session-mutation-flow.js';
import { stripAnsi } from '../../src/tui/rendering/text.js';

const SESSION_ID = 'session-history';
const SUMMARY: TuiSessionInputSummary = {
  userMessageId: 'user-history-1',
  assistantMessageId: 'assistant-history-1',
  contentHead: 'Change the historical input',
  timestamp: 1_700_000_000_000,
  fileChangeCount: 1,
};

function createHarness(
  realHost?: TuiSurfaceHost,
  overrides: {
    hasLiveRun?: () => boolean;
    getSessionForkOptions?: () => Promise<TuiSessionForkOptions>;
  } = {},
) {
  const listSessionInputSummaries = vi.fn(async () => [SUMMARY]);
  const getSessionRewindPreview = vi.fn(async () => ({
    turns: [
      {
        turnId: 'turn-history-1',
        files: [{ filePath: 'src/history.ts', action: 'modified' as const, skipped: false }],
      },
    ],
  }));
  const rewindSession = vi.fn(async () => ({ rewound: true }));
  const listMessagePage = vi.fn(async () => ({
    messages: [
      {
        id: SUMMARY.userMessageId,
        role: 'user' as const,
        content: 'Full historical input',
        timestamp: SUMMARY.timestamp,
      },
    ],
    hasMore: false,
  }));
  const editSessionMessage = vi.fn();
  const getSessionForkOptions = vi.fn(
    overrides.getSessionForkOptions ??
      (async () => ({
        canFork: true,
        suggestedTitle: '2 - History test',
        sourceTitle: 'History test',
        worktreeVisible: false,
        worktreeEligible: false,
      })),
  );
  const forkSession = vi.fn(async (input: { sessionId: string; clientRequestId: string }) => ({
    session: { sessionId: 'session-clone', title: '2 - History test' },
    sourceDisplayMessageId: input.sessionId,
  }));
  const activateSessionById = vi.fn(async () => undefined);
  const pushedScreens: Array<TuiFeatureScreen & {
    id: string;
    handleInput(data: string): void;
    render(width: number): string[];
  }> = [];
  const closeHandles: Array<ReturnType<typeof vi.fn>> = [];
  const surfaceHost = {
    pushFeature: vi.fn(
      ({
        screen,
      }: {
        screen: TuiFeatureScreen & { handleInput(data: string): void };
      }) => {
        pushedScreens.push(screen);
        const realHandle = realHost?.pushFeature({ screen });
        const close = vi.fn(() => realHandle?.close() ?? true);
        closeHandles.push(close);
        return { id: screen.id, close, isActive: () => true };
      },
    ),
    setChatFocus: vi.fn(),
  };
  const editor = { setText: vi.fn() };
  const setHint = vi.fn();
  const append = vi.fn();
  const refreshProjection = vi.fn(async () => undefined);
  const reloadSessionProjection = vi.fn(async () => undefined);
  const setEditTranscriptBoundary = vi.fn();
  const flow = new TuiSessionMutationFlow({
    runtime: {
      listSessionInputSummaries,
      getSessionRewindPreview,
      rewindSession,
      listMessagePage,
      editSessionMessage,
      getSessionForkOptions,
      forkSession,
    } as never,
    controller: {
      snapshot: () => ({
        session: { sessionId: SESSION_ID, title: 'History test' },
        sessions: [],
      }),
    } as never,
    sessionFlow: { activateSessionById } as never,
    refreshProjection,
    reloadSessionProjection,
    surfaceHost: surfaceHost as never,
    editor: editor as never,
    setHint,
    append,
    setEditTranscriptBoundary,
    onChanged: vi.fn(),
    hasLiveRun: overrides.hasLiveRun ?? (() => false),
  });
  return {
    flow,
    listSessionInputSummaries,
    getSessionRewindPreview,
    rewindSession,
    listMessagePage,
    editSessionMessage,
    getSessionForkOptions,
    forkSession,
    activateSessionById,
    pushedScreens,
    closeHandles,
    surfaceHost,
    editor,
    refreshProjection,
    reloadSessionProjection,
    setEditTranscriptBoundary,
    setHint,
    append,
  };
}

describe('TuiSessionMutationFlow history explorer', () => {
  it.each([8, 24, 50])(
    'restores chat after cancelling the real rewind confirmation at %i rows',
    async (rows) => {
      const terminal = new VirtualTerminal(80, rows);
      const tui = new TuiMainScreen(terminal);
      const chat = [
        ...Array.from({ length: 80 }, (_, index) => `BACKGROUND-${index}`),
        'COMPOSER',
        'STATUS',
      ];
      const component = { render: () => chat, invalidate() {} };
      const host = new TuiSurfaceHost({
        chat: { component, focus: component },
        chatMode: 'regular',
        viewportRows: () => terminal.rows,
        regularFeaturePresenter: new TuiOverlayRegularFeaturePresenter(terminal, tui, () =>
          tui.requestRender(),
        ),
        setFocus: (focus) => tui.setFocus(focus),
        requestRender: () => tui.requestRender(),
      });
      const harness = createHarness(host);
      tui.addChild(host);
      tui.start();
      try {
        await terminal.waitForRender();
        harness.flow.startHistory();
        await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(1));
        // Choose conversation-only rewind through the actual history action menu.
        for (const key of ['\r', '\x1b[B', '\x1b[B', '\r']) terminal.sendInput(key);
        await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(2));
        tui.renderNow();
        await terminal.flush();
        expect(harness.pushedScreens[1]?.id).toBe('session-mutation:rewind-confirm');
        expect(terminal.getViewport().join('\n')).not.toMatch(/BACKGROUND-|COMPOSER|STATUS/);
        terminal.sendInput('\x1b');
        tui.renderNow();
        await terminal.flush();
        expect(host.getActiveSurface()).toEqual({
          kind: 'feature',
          id: 'session-history:explorer',
        });
        terminal.sendInput('\x1b');
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport()).toEqual(chat.slice(-rows));
        expect(terminal.getScrollBuffer()).toEqual(chat);
        expect(harness.rewindSession).not.toHaveBeenCalled();
      } finally {
        host.dispose();
        tui.stop();
      }
    },
  );

  it('confirms a conversation-only rewind without an irrelevant file preview', async () => {
    const harness = createHarness();

    harness.flow.startHistory();
    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(1));
    expect(harness.pushedScreens[0]?.id).toBe('session-history:explorer');

    harness.pushedScreens[0]?.handleInput('\r');
    harness.pushedScreens[0]?.handleInput('\u001b[B');
    harness.pushedScreens[0]?.handleInput('\u001b[B');
    harness.pushedScreens[0]?.handleInput('\r');

    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(2));
    expect(harness.pushedScreens[1]?.id).toBe('session-mutation:rewind-confirm');
    expect(harness.getSessionRewindPreview).not.toHaveBeenCalled();
    expect(harness.rewindSession).not.toHaveBeenCalled();

    harness.pushedScreens[1]?.handleInput('\r');
    await vi.waitFor(() =>
      expect(harness.rewindSession).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        userMessageId: SUMMARY.userMessageId,
        clientRequestId: expect.stringMatching(/^tui-rewind_/u),
      }),
    );
    await vi.waitFor(() =>
      expect(harness.reloadSessionProjection).toHaveBeenCalledWith(SESSION_ID),
    );
    expect(harness.refreshProjection).not.toHaveBeenCalled();
    expect(harness.flow.getInvocationCountForTesting()).toBe(0);
  });

  it('restores the history explorer after cancelling a conversation-only rewind', async () => {
    const harness = createHarness();

    harness.flow.startHistory();
    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(1));
    const explorer = harness.pushedScreens[0];
    explorer?.handleInput('\r');
    explorer?.handleInput('\u001b[B');
    explorer?.handleInput('\u001b[B');
    explorer?.handleInput('\r');

    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(2));
    harness.pushedScreens[1]?.handleInput('\u001b');

    expect(harness.flow.getInvocationCountForTesting()).toBe(0);
    expect(stripAnsi(explorer?.render(100).join('\n') ?? '')).toContain('Search:');
    explorer?.handleInput('\r');
    expect(stripAnsi(explorer?.render(100).join('\n') ?? '')).toContain('Choose history action');
  });

  it('previews a historical edit before loading it into the composer', async () => {
    const harness = createHarness();

    harness.flow.startHistory();
    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(1));
    harness.pushedScreens[0]?.handleInput('\r');
    harness.pushedScreens[0]?.handleInput('\u001b[B');
    harness.pushedScreens[0]?.handleInput('\r');

    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(2));
    expect(harness.pushedScreens[1]?.id).toBe('session-mutation:rewind-preview');
    expect(harness.listMessagePage).not.toHaveBeenCalled();
    expect(harness.editor.setText).not.toHaveBeenCalled();

    harness.pushedScreens[1]?.handleInput('\r');
    await vi.waitFor(() =>
      expect(harness.listMessagePage).toHaveBeenCalledWith(SESSION_ID, {
        limit: 100,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.editor.setText).toHaveBeenCalledWith('Full historical input'),
    );
    expect(harness.setEditTranscriptBoundary).toHaveBeenCalledWith(SUMMARY.userMessageId);
    expect(harness.surfaceHost.setChatFocus).toHaveBeenCalled();
    expect(harness.editSessionMessage).not.toHaveBeenCalled();
  });

  it('uses the file preview as the final confirmation for a file rewind', async () => {
    const harness = createHarness();

    harness.flow.startHistory();
    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(1));
    harness.pushedScreens[0]?.handleInput('\r');
    harness.pushedScreens[0]?.handleInput('\u001b[B');
    harness.pushedScreens[0]?.handleInput('\u001b[B');
    harness.pushedScreens[0]?.handleInput('\u001b[B');
    harness.pushedScreens[0]?.handleInput('\r');

    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(2));
    expect(harness.pushedScreens[1]?.id).toBe('session-mutation:rewind-preview');
    expect(harness.rewindSession).not.toHaveBeenCalled();

    harness.pushedScreens[1]?.handleInput('\r');
    await vi.waitFor(() =>
      expect(harness.rewindSession).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        userMessageId: SUMMARY.userMessageId,
        clientRequestId: expect.stringMatching(/^tui-rewind_/u),
        rewindTurnDiff: true,
      }),
    );
    expect(harness.pushedScreens).toHaveLength(2);
  });
});

describe('TuiSessionMutationFlow clone', () => {
  it('copies the Session at the latest reply without asking for a boundary', async () => {
    const harness = createHarness();

    harness.flow.startClone();
    await vi.waitFor(() => expect(harness.pushedScreens).toHaveLength(1));

    // No boundary argument: the runtime resolves the latest assistant reply.
    expect(harness.getSessionForkOptions).toHaveBeenCalledWith(SESSION_ID, undefined);
    const card = stripAnsi(harness.pushedScreens[0]?.render(80).join('\n') ?? '');
    expect(card).toContain('Confirm copy');
    expect(card).toContain('Includes the conversation up to the latest reply.');
    expect(card).not.toContain('From');

    harness.pushedScreens[0]?.handleInput('\r');
    await vi.waitFor(() => expect(harness.forkSession).toHaveBeenCalledTimes(1));
    expect(harness.forkSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      clientRequestId: expect.stringMatching(/^tui-clone_/u),
      useSuggestedTitle: true,
      createIsolatedWorktree: false,
    });
    await vi.waitFor(() =>
      expect(harness.activateSessionById).toHaveBeenCalledWith('session-clone'),
    );
  });

  it('keeps the draft and stays out of the pipeline while a turn is running', () => {
    const harness = createHarness(undefined, { hasLiveRun: () => true });

    harness.flow.startClone();

    expect(harness.editor.setText).toHaveBeenCalledWith('/clone');
    expect(harness.getSessionForkOptions).not.toHaveBeenCalled();
    expect(harness.forkSession).not.toHaveBeenCalled();
    expect(harness.pushedScreens).toHaveLength(0);
    expect(harness.setHint).toHaveBeenCalledWith(
      'Wait for the current response or press Esc to interrupt before copying this Session.',
    );
  });

  it('reports why a Session cannot be copied yet', async () => {
    const harness = createHarness(undefined, {
      getSessionForkOptions: async () => ({
        canFork: false,
        unavailableReason: 'no complete reply yet',
        worktreeVisible: false,
        worktreeEligible: false,
      }),
    });

    harness.flow.startClone();

    await vi.waitFor(() =>
      expect(harness.append).toHaveBeenCalledWith('Copy unavailable: no complete reply yet', 'warning'),
    );
    expect(harness.pushedScreens).toHaveLength(0);
    expect(harness.forkSession).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { TuiRuntimeEventFlow } from '../../src/tui/controller/runtime/runtime-event-flow.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';

function delta(content: string, turnId = 'turn-a'): TuiStreamEvent {
  return { type: 'delta', turnId, messageId: `message-${turnId}`, content, timestamp: 5 };
}

interface HarnessOptions {
  /** Whether the Session has a pane on the bar; defaults to true. */
  readonly retainsTranscript?: (sessionId: string) => boolean;
  /** Runs after each stream event is yielded, so a test can switch Sessions. */
  readonly onStreamEvent?: () => void;
}

/**
 * A flow whose Runtime streams one turn and whose controller stub records where each
 * event was routed. `visible` is mutable so a test can switch Sessions mid-stream,
 * which is what a Session switch does.
 */
function createFlow(events: readonly TuiStreamEvent[], options: HarnessOptions = {}) {
  let visible: string | undefined = 'session-a';
  const watchSessionTurn = vi.fn(async function* watchSessionTurn() {
    for (const event of events) {
      yield event;
      options.onStreamEvent?.();
    }
  });
  const applyRuntimeTurnEvent = vi.fn(() => undefined);
  const applyBackgroundTurnEvent = vi.fn(() => undefined);
  const settleBackgroundTurn = vi.fn();
  const beginRuntimeTurn = vi.fn();
  const beginBackgroundTurn = vi.fn();
  const markRecoveredTurn = vi.fn();

  const flow = new TuiRuntimeEventFlow({
    runtime: { watchSessionTurn, getActiveRun: async () => undefined } as never,
    controller: {
      snapshot: () => ({
        session: visible ? { sessionId: visible } : undefined,
        activeTurnId: undefined,
      }),
      beginRuntimeTurn,
      beginBackgroundTurn,
      applyRuntimeTurnEvent,
      applyBackgroundTurnEvent,
      settleBackgroundTurn,
      retainsTranscript: options.retainsTranscript ?? (() => true),
      latestDurableMessageId: () => undefined,
      refreshSessionMetadata: async () => undefined,
    } as never,
    stateStore: { snapshot: () => ({}) } as never,
    effectRunner: { run: async () => undefined } as never,
    stateCoordinator: { project: () => undefined } as never,
    sessionFlow: { reconcileRuntimeEvent: async () => undefined } as never,
    delegationFlow: {
      handleRuntimeEvent: async () => undefined,
      handleSettledRuntimeEvent: async () => undefined,
      refresh: async () => undefined,
    } as never,
    activeRunFlow: { refresh: async () => undefined, currentSnapshot: () => undefined } as never,
    interactionFlow: {
      continuesTurn: () => false,
      handleRuntimeEvent: async () => false,
    } as never,
    runProjection: { markRecoveredTurn, markQueueHandoffPending: () => undefined } as never,
    releaseQueueItem: async () => undefined,
    transcript: new TranscriptStore(),
    refreshQueue: async () => [],
    projectQueueItem: () => undefined,
    updateFollowUpPanel: () => undefined,
    onChanged: () => undefined,
    append: () => undefined,
    isStopped: () => false,
    queueEnabled: false,
  });

  return {
    flow,
    setVisible: (sessionId: string | undefined) => {
      visible = sessionId;
    },
    applyRuntimeTurnEvent,
    applyBackgroundTurnEvent,
    settleBackgroundTurn,
    beginRuntimeTurn,
    beginBackgroundTurn,
  };
}

describe('TuiRuntimeEventFlow live turns', () => {
  it('keeps streaming a turn whose Session is no longer on screen', async () => {
    const harness = createFlow(
      [delta('hello'), { type: 'done', turnId: 'turn-a' }],
      { onStreamEvent: () => harness.setVisible('session-b') },
    );

    harness.flow.adoptRuntimeTurn('session-a', 'turn-a', 100);

    await vi.waitFor(() => expect(harness.settleBackgroundTurn).toHaveBeenCalledOnce());
    // The first event was applied while its Session was on screen…
    expect(harness.applyRuntimeTurnEvent).toHaveBeenCalledOnce();
    // …and the turn kept being consumed after the switch, into its own pane.
    expect(harness.applyBackgroundTurnEvent).toHaveBeenCalledWith(
      'session-a',
      'turn-a',
      expect.objectContaining({ type: 'done' }),
    );
    expect(harness.settleBackgroundTurn).toHaveBeenCalledWith(
      'session-a',
      'turn-a',
      'succeeded',
      expect.any(Number),
    );
  });

  it('routes a turn back to the visible projection when its Session comes back', async () => {
    let switchedBack = false;
    const harness = createFlow([delta('one'), delta('two')], {
      onStreamEvent: () => {
        if (switchedBack) return;
        switchedBack = true;
        harness.setVisible('session-b');
        harness.setVisible('session-a');
      },
    });

    harness.flow.adoptRuntimeTurn('session-a', 'turn-a', 100);

    await vi.waitFor(() => expect(harness.applyRuntimeTurnEvent).toHaveBeenCalledTimes(2));
    expect(harness.applyBackgroundTurnEvent).not.toHaveBeenCalled();
    expect(harness.settleBackgroundTurn).not.toHaveBeenCalled();
  });

  it('anchors a turn in the pane of the Session that is on screen', async () => {
    const harness = createFlow([delta('hello')]);

    harness.flow.adoptRuntimeTurn('session-a', 'turn-a', 100);

    await vi.waitFor(() => expect(harness.applyRuntimeTurnEvent).toHaveBeenCalledOnce());
    expect(harness.beginRuntimeTurn).toHaveBeenCalledWith('turn-a', 100);
    // A turn that started on screen keeps writing through the visible projection; the
    // background pane is anchored only once the Session is no longer the pane.
    expect(harness.beginBackgroundTurn).not.toHaveBeenCalled();
  });

  it('watches a turn that starts in a Session whose tab is open but not on screen', async () => {
    const harness = createFlow([
      delta('from the background run', 'turn-b'),
      { type: 'done', turnId: 'turn-b' },
    ]);

    harness.flow.adoptRuntimeTurn('session-b', 'turn-b', 100);

    await vi.waitFor(() => expect(harness.settleBackgroundTurn).toHaveBeenCalledOnce());
    expect(harness.beginBackgroundTurn).toHaveBeenCalledWith('session-b', 'turn-b', 100);
    expect(harness.applyBackgroundTurnEvent).toHaveBeenCalledWith(
      'session-b',
      'turn-b',
      expect.objectContaining({ type: 'delta' }),
    );
    expect(harness.applyRuntimeTurnEvent).not.toHaveBeenCalled();
  });

  it('leaves a turn in a Session with no pane on the bar alone', async () => {
    const harness = createFlow([delta('from the background run', 'turn-b')], {
      retainsTranscript: () => false,
    });

    harness.flow.adoptRuntimeTurn('session-b', 'turn-b', 100);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.applyBackgroundTurnEvent).not.toHaveBeenCalled();
    expect(harness.beginBackgroundTurn).not.toHaveBeenCalled();
  });
});

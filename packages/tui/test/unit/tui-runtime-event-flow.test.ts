import { describe, expect, it, vi } from 'vitest';

import { TuiRuntimeEventFlow } from '../../src/tui/controller/runtime/runtime-event-flow.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';

function delta(content: string): TuiStreamEvent {
  return { type: 'delta', turnId: 'turn-a', messageId: 'message-a', content, timestamp: 5 };
}

/**
 * A flow whose only Runtime skill is streaming one turn, wired to a controller stub
 * that records where each event was routed. `visible` is mutable so a test can switch
 * Sessions in the middle of the stream, which is what a Session switch does.
 */
function createFlow(events: readonly TuiStreamEvent[], onEvent?: () => void) {
  let visible: string | undefined = 'session-a';
  const watchSessionTurn = vi.fn(async function* watchSessionTurn() {
    for (const event of events) {
      yield event;
      onEvent?.();
    }
  });
  const applyRuntimeTurnEvent = vi.fn(() => undefined);
  const applyBackgroundTurnEvent = vi.fn(() => undefined);
  const settleBackgroundTurn = vi.fn();
  const beginRuntimeTurn = vi.fn();
  const beginBackgroundTurn = vi.fn();
  const markRecoveredTurn = vi.fn();

  const flow = new TuiRuntimeEventFlow({
    runtime: { watchSessionTurn } as never,
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
      latestDurableMessageId: () => undefined,
    } as never,
    stateStore: { snapshot: () => ({}) } as never,
    effectRunner: {} as never,
    stateCoordinator: {} as never,
    sessionFlow: {} as never,
    delegationFlow: {} as never,
    activeRunFlow: { refresh: async () => undefined, currentSnapshot: () => undefined } as never,
    interactionFlow: { continuesTurn: () => false } as never,
    runProjection: { markRecoveredTurn } as never,
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

async function waitForAssertion(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion);
}

describe('TuiRuntimeEventFlow live turns', () => {
  it('keeps streaming a turn whose Session is no longer on screen', async () => {
    const harness = createFlow(
      [delta('hello'), { type: 'done', turnId: 'turn-a' }],
      () => harness.setVisible('session-b'),
    );

    harness.flow.adoptRuntimeTurn('session-a', 'turn-a', 100);

    await waitForAssertion(() => expect(harness.settleBackgroundTurn).toHaveBeenCalledOnce());
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
    const harness = createFlow([delta('one'), delta('two')], () => {
      if (switchedBack) return;
      switchedBack = true;
      harness.setVisible('session-b');
      harness.setVisible('session-a');
    });

    harness.flow.adoptRuntimeTurn('session-a', 'turn-a', 100);

    await waitForAssertion(() => expect(harness.applyRuntimeTurnEvent).toHaveBeenCalledTimes(2));
    expect(harness.applyBackgroundTurnEvent).not.toHaveBeenCalled();
    expect(harness.settleBackgroundTurn).not.toHaveBeenCalled();
  });

  it('anchors a turn in the pane of the Session that is on screen', async () => {
    const harness = createFlow([delta('hello')]);

    harness.flow.adoptRuntimeTurn('session-a', 'turn-a', 100);

    await waitForAssertion(() => expect(harness.applyRuntimeTurnEvent).toHaveBeenCalledOnce());
    expect(harness.beginRuntimeTurn).toHaveBeenCalledWith('turn-a', 100);
    // A turn that started on screen keeps writing through the visible projection; the
    // background pane is anchored only once the Session is no longer the pane.
    expect(harness.beginBackgroundTurn).not.toHaveBeenCalled();
  });
});

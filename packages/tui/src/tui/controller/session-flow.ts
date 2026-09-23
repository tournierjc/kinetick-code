import type {
  TuiActiveRunControlPort,
  TuiActiveRunSnapshot,
  TuiSession,
  TuiSessionForkPort,
  TuiSessionPort,
} from '../../runtime/port.js';
import type { TuiObservability } from '../../observability/index.js';
import type { TuiRotationEvent, TuiSessionCatalogEvent } from '../../types/runtime-events.js';
import type { TuiComposerDraft } from '../features/composer/draft.js';
import type { TuiRunProjection } from '../state/run-projection.js';
import type { TuiStateStore } from '../state/store.js';
import {
  applyingTuiTabGroupCollapse,
  foldingTuiTabGroups,
  cycleTuiTab,
  selectTuiTabAfterClose,
  selectTuiTabSlot,
} from '../state/tabs.js';
import {
  resolveTuiSessionTabGroupRefs,
  type TuiSessionTabGroupRef,
} from '../shell/session-tabs.js';
import type { TuiChatController } from './chat-controller.js';
import type { TuiFeatureFlow } from './product/feature-flow.js';
import type { TuiInteractionFlow } from './interaction/interaction-flow.js';
import type { TuiQueueFlow } from './run/queue-flow.js';
import type { TuiDelegationFlow } from './delegation-flow.js';
import type { TuiActiveRunFlow } from './run/active-run-flow.js';
import type { TuiGoalFlow } from './product/goal-flow.js';
import {
  isTuiBuiltinSubagentSession,
  isTuiInternalSubagentSession,
} from '../../runtime/delegation.js';
import {
  BTW_SIDE_SESSION_PURPOSE,
  BTW_SIDE_SESSION_TITLE,
  BTW_REJECT_NO_BOUNDARY,
  isSideSession,
  resolveBtwStartDecision,
} from '../commands/side-session.js';

export interface TuiSessionFlowOptions {
  readonly observability?: Pick<TuiObservability, 'recordSideSessionFailure'>;
  readonly runtime: Pick<
    TuiSessionPort,
    'getSession' | 'listSessionPage' | 'createSession' | 'deleteSession'
  > &
    Partial<Pick<TuiSessionForkPort, 'getSessionForkOptions'>> &
    Partial<Pick<TuiActiveRunControlPort, 'getActiveRun'>>;
  readonly controller: TuiChatController;
  readonly stateStore: TuiStateStore;
  readonly composerDraft: TuiComposerDraft;
  readonly interactionFlow: TuiInteractionFlow;
  readonly featureFlow: TuiFeatureFlow;
  readonly queueFlow: Pick<TuiQueueFlow, 'reset' | 'refresh'>;
  readonly delegationFlow: Pick<TuiDelegationFlow, 'reset' | 'refresh'>;
  readonly activeRunFlow: Pick<TuiActiveRunFlow, 'refresh'> & {
    /** The snapshot fetched during activation, when Runtime reconciliation succeeded. */
    readonly currentSnapshot?: () => TuiActiveRunSnapshot | undefined;
  };
  readonly goalFlow?: Pick<TuiGoalFlow, 'refresh' | 'reset'>;
  readonly runProjection: TuiRunProjection;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly onChanged: () => void;
  readonly followBottom?: () => void;
  readonly requestWelcomeRebuild: () => void;
  readonly switchComposerDraft?: (sessionKey: string) => Promise<void>;
  readonly adoptForegroundRun?: () => void;
  readonly preparePluginHookSessionSwitch?: (
    sessionId: string,
    reason: 'clear' | 'resume_other',
  ) => Promise<void>;
  readonly hasLiveRun?: () => boolean;
  /** Stops the foreground side Turn before its ephemeral Session is removed. */
  readonly abortForegroundRun?: () => Promise<boolean>;
  readonly currentRunId?: () => string | undefined;
  readonly onSideSessionOpened?: (input: {
    readonly parentSessionId: string;
    readonly sideSessionId: string;
  }) => void;
  readonly onSideSessionClosed?: (input: {
    readonly parentSessionId: string;
    readonly sideSessionId: string;
    readonly sideRunId?: string;
    readonly exitReason: 'ctrl_c' | 'ctrl_d' | 'navigation' | 'replaced';
  }) => void;
  /** Interrupts a possibly detached run owned by the given Session. */
  readonly abortSessionRun?: (sessionId: string) => Promise<boolean>;
  readonly onSideConversationChanged?: (snapshot: TuiSideConversationSnapshot | undefined) => void;
}

export interface TuiSideConversationSnapshot {
  readonly parentSessionId: string;
  readonly sideSessionId: string;
  readonly activeView: 'parent' | 'side';
}

export class TuiSessionFlow {
  private sessionSequence = 0;
  private stopped = false;
  private sideConversation: TuiSideConversationSnapshot | undefined;

  constructor(private readonly options: TuiSessionFlowOptions) {}

  stop(): void {
    this.stopped = true;
    this.sessionSequence += 1;
  }

  isSideModeActive(): boolean {
    return this.sideConversation?.activeView === 'side';
  }

  sideConversationSnapshot(): TuiSideConversationSnapshot | undefined {
    return this.sideConversation;
  }

  /** Open tabs in bar order; the visible Session is always one of them. */
  private openTabOrder(): readonly string[] {
    return this.options.stateStore.snapshot().tabs.order;
  }

  /** Project of the visible Session, used to fold and unfold its group. */
  private visibleGroupRef(): TuiSessionTabGroupRef | undefined {
    const sessionId = this.visibleSessionId();
    if (!sessionId) return undefined;
    return resolveTuiSessionTabGroupRefs(this.options.controller.snapshot().sessions).get(
      sessionId,
    );
  }

  private visibleSessionId(): string | undefined {
    return this.options.controller.snapshot().session?.sessionId;
  }

  /**
   * Switch to the next (`delta` 1) or previous (`delta` -1) open tab.
   *
   * Switching keeps the same live-run rule as `/sessions`. The projection is
   * still single-Session: loading another Session detaches the foreground run
   * and aborts its turn, so allowing the switch mid-run would silently kill the
   * run instead of leaving it in the background.
   *
   * Folding a project group only changes what the bar draws, so cycling walks
   * every open tab and a folded group stays reachable from the keyboard.
   */
  async cycleTab(delta: 1 | -1): Promise<void> {
    const current = this.visibleSessionId();
    const target = cycleTuiTab(this.openTabOrder(), current, delta);
    if (!target || target === current) {
      this.options.append('Only one Session tab is open. Use /sessions to open another.', 'warning');
      return;
    }
    await this.activateSessionById(target);
  }

  /** Switch to the Session bound to a 1-based direct tab slot (`Alt+<n>`). */
  async activateTabSlot(slot: number): Promise<void> {
    const target = selectTuiTabSlot(this.openTabOrder(), slot);
    if (!target) {
      this.options.append(`No open Session tab in slot ${slot}.`, 'warning');
      return;
    }
    if (target === this.visibleSessionId()) return;
    await this.activateSessionById(target);
  }

  /**
   * Close the visible tab and show its neighbour.
   *
   * The neighbour is activated *before* the close because the tab list refuses
   * to close the visible tab; that keeps the invariant that a Session is always
   * on screen. Closing the last tab starts a new Session instead. Nothing is
   * deleted: the Session keeps its history and returns through `/sessions`.
   *
   * A refused switch (live run, or a failed projection load) leaves the tab in
   * place rather than dropping it silently.
   */
  async closeTab(): Promise<void> {
    if (this.stopped) return;
    const current = this.visibleSessionId();
    if (!current) return;
    if (this.options.hasLiveRun?.()) {
      // Closing would detach the turn with nothing left on the bar to return to.
      this.options.append('Stop the running turn before closing its tab.', 'warning');
      this.options.onChanged();
      return;
    }
    const neighbour = selectTuiTabAfterClose(this.openTabOrder(), current);
    if (neighbour) {
      await this.activateSessionById(neighbour);
      if (this.visibleSessionId() !== neighbour) return;
    } else {
      await this.startNew();
      if (this.visibleSessionId() !== undefined) return;
    }
    this.options.stateStore.dispatch({ type: 'tabs/close', sessionId: current });
    // The closed Session has no tab left, so its pane is released with it.
    this.options.controller.releaseSessionTranscript(current);
    this.options.onChanged();
  }

  /**
   * Rename the visible Session, which is what the tab label shows.
   *
   * Without a title the session manager opens on its rename field, so the tab
   * and `/sessions` share one rename affordance and one source of truth; the bar
   * re-reads the catalog on the next frame, so no refresh is needed here.
   */
  async renameTab(title?: string): Promise<void> {
    if (this.stopped) return;
    const sessionId = this.visibleSessionId();
    if (!sessionId) {
      this.options.append('Start or resume a Session before renaming its tab.', 'warning');
      return;
    }
    const trimmed = title?.trim();
    if (!trimmed) {
      await this.options.featureFlow.showSessionManager('', { initialRenameSessionId: sessionId });
      return;
    }
    const renamed = await this.options.controller.renameSession(sessionId, trimmed);
    this.options.append(`Session renamed to “${renamed.title?.trim() || trimmed}”.`);
    this.options.onChanged();
  }

  /** Group the tab bar by project, or go back to a single strip. */
  async setTabGrouping(grouped: boolean): Promise<void> {
    const state = this.options.stateStore.snapshot();
    if (state.tabs.grouped === grouped) return;
    this.options.stateStore.dispatch({ type: 'tabs/toggleGrouping', grouped });
    const refs = resolveTuiSessionTabGroupRefs(this.options.controller.snapshot().sessions);
    const open = new Set(state.tabs.order);
    const projects = new Set(
      [...refs.entries()]
        .filter(([sessionId]) => open.has(sessionId))
        .map(([, ref]) => ref.key),
    );
    if (grouped && projects.size < 2) {
      this.options.append('Grouping needs tabs from more than one project.');
    }
    this.options.onChanged();
  }

  /**
   * Fold every project group but the one holding the visible tab, or unfold them
   * all again.
   *
   * Folding the visible tab's own group would hide the Session on screen — the
   * same rule that stops the visible tab from being closed — so the key folds the
   * groups *around* it. Cycling and the direct slots still reach every open tab,
   * so a folded group is never a keyboard dead end.
   */
  async toggleTabGroupCollapse(): Promise<void> {
    const state = this.options.stateStore.snapshot();
    const ref = this.visibleGroupRef();
    if (!ref || !state.tabs.grouped) {
      this.options.append('Project grouping is off. Turn it on with /tabs group on.', 'warning');
      return;
    }
    const refs = resolveTuiSessionTabGroupRefs(this.options.controller.snapshot().sessions);
    const groupKeys = [...new Set(state.tabs.order.map((id) => refs.get(id)?.key))].filter(
      (key): key is string => key !== undefined,
    );
    const folded = foldingTuiTabGroups(groupKeys, ref.key, state.tabs.collapsedGroups);
    if (folded === state.tabs.collapsedGroups) {
      this.options.append('Only one project group is open, so there is nothing to fold.', 'warning');
      return;
    }
    this.options.stateStore.dispatch({ type: 'tabs/setCollapsedGroups', groupKeys: folded });
    this.options.append(
      folded.length === 0
        ? 'Showing every project group again.'
        : `${ref.label} holds the visible tab, so it stays open; the other project groups are folded.`,
    );
    this.options.onChanged();
  }

  async startNew(
    options: {
      readonly endPreviousSession?: boolean;
      readonly allowDuringLiveRun?: boolean;
    } = {},
  ): Promise<void> {
    if (this.stopped) return;
    if (!options.allowDuringLiveRun && !this.allowUserSessionNavigation('/new')) return;
    await this.disposeSideConversation();
    const sessionSequence = ++this.sessionSequence;
    const previousSessionId = this.options.controller.snapshot().session?.sessionId;
    const previousSessionKey = previousSessionId ?? 'new-session';
    if (this.options.switchComposerDraft) {
      await this.options.switchComposerDraft('new-session');
    } else {
      await this.options.composerDraft.discard();
    }
    if (this.stopped || sessionSequence !== this.sessionSequence) return;
    this.options.interactionFlow.deactivate();
    this.options.featureFlow.resetSessionState();
    try {
      this.options.controller.startNewSession(options.endPreviousSession !== false);
    } catch (error) {
      await this.options.switchComposerDraft?.(previousSessionKey);
      await this.options.activeRunFlow.refresh(true).catch(() => undefined);
      this.options.adoptForegroundRun?.();
      throw error;
    }
    if (previousSessionId && options.endPreviousSession !== false) {
      await this.options.preparePluginHookSessionSwitch?.(previousSessionId, 'clear');
    }
    if (this.stopped || sessionSequence !== this.sessionSequence) return;
    this.options.stateStore.dispatch({ type: 'session/activate', sessionId: undefined });
    this.options.queueFlow.reset();
    this.options.delegationFlow.reset();
    this.options.goalFlow?.reset();
    this.options.followBottom?.();
    this.options.requestWelcomeRebuild();
    await this.options.featureFlow.refreshSelectedModel(undefined);
  }

  async activateSessionById(
    sessionId: string,
    options: {
      /** Internal parent/side projection switch; keep the pair alive. */
      readonly preserveSideConversation?: boolean;
    } = {},
  ): Promise<void> {
    if (this.stopped) return;
    // Switching leaves the previous Session's turn running: the controller aborts
    // only its own delivery stream and detaches the run, and the tab keeps showing
    // the state from the Runtime events, so no navigation gate is needed here.
    const previousHadLiveRun = Boolean(this.options.hasLiveRun?.());
    if (!options.preserveSideConversation) await this.disposeSideConversation();
    const sessionSequence = ++this.sessionSequence;
    const requestedSessionId = sessionId;
    const resolvedSession = await this.resolveUserNavigableSession(sessionId);
    if (this.stopped || sessionSequence !== this.sessionSequence) return;
    const targetSessionId = resolvedSession.sessionId;
    const previousSessionId = this.options.controller.snapshot().session?.sessionId;
    const previousSessionKey = previousSessionId ?? 'new-session';
    await this.options.switchComposerDraft?.(targetSessionId);
    if (this.stopped || sessionSequence !== this.sessionSequence) return;
    try {
      await this.options.controller.loadSessionProjection(targetSessionId);
    } catch (error) {
      if (sessionSequence === this.sessionSequence) {
        await this.options.switchComposerDraft?.(previousSessionKey);
        await this.options.activeRunFlow.refresh(true).catch(() => undefined);
        this.options.adoptForegroundRun?.();
      }
      throw error;
    }
    if (
      this.stopped ||
      sessionSequence !== this.sessionSequence ||
      this.options.controller.snapshot().session?.sessionId !== targetSessionId
    ) {
      return;
    }
    if (
      previousSessionId &&
      previousSessionId !== targetSessionId &&
      !options.preserveSideConversation
    ) {
      await this.options.preparePluginHookSessionSwitch?.(previousSessionId, 'resume_other');
    }
    if (
      this.stopped ||
      sessionSequence !== this.sessionSequence ||
      this.options.controller.snapshot().session?.sessionId !== targetSessionId
    ) {
      return;
    }
    this.options.queueFlow.reset();
    const openedSession = this.options.controller.snapshot().session;
    this.options.runProjection.markRecoveredTurn(
      isRuntimeSessionRunning(openedSession) ? `session:${targetSessionId}` : undefined,
    );
    this.options.interactionFlow.deactivate();
    this.options.featureFlow.resetSessionState();
    this.options.delegationFlow.reset();
    if (options.preserveSideConversation && this.sideConversation) {
      this.sideConversation = {
        ...this.sideConversation,
        activeView: targetSessionId === this.sideConversation.sideSessionId ? 'side' : 'parent',
      };
      this.options.onSideConversationChanged?.(this.sideConversation);
    }
    this.options.followBottom?.();
    this.options.onChanged();
    if (previousHadLiveRun && previousSessionId && previousSessionId !== targetSessionId) {
      // The turn was detached, not cancelled: say so, because the composer and the
      // status line now describe the Session on screen.
      this.options.append(
        'The previous Session keeps running in the background; switch back to its tab to watch it.',
      );
    }
    if (requestedSessionId !== targetSessionId) {
      this.options.append(
        'Sub-agent Sessions are internal. Opened the parent Session instead.',
        'warning',
      );
    }

    const queueHydration = this.options.queueFlow.refresh(targetSessionId);
    const modelHydration = this.options.featureFlow.refreshSelectedModel(targetSessionId);
    const delegationHydration = this.options.delegationFlow.refresh();
    const decisionHydration = delegationHydration.then(() =>
      this.options.interactionFlow.recover(targetSessionId),
    );
    const activeRunHydration = this.options.activeRunFlow.refresh(true);
    const goalHydration = this.options.goalFlow?.refresh(targetSessionId);
    await Promise.all([
      queueHydration,
      modelHydration,
      decisionHydration,
      delegationHydration,
      activeRunHydration,
      goalHydration,
    ]);
    this.reconcileRuntimeProjection(targetSessionId);
    this.options.onChanged();
    if (
      !this.stopped &&
      sessionSequence === this.sessionSequence &&
      this.options.controller.snapshot().session?.sessionId === targetSessionId
    ) {
      this.options.adoptForegroundRun?.();
    }
  }

  private reconcileRuntimeProjection(sessionId: string): void {
    const activeRun = this.options.activeRunFlow.currentSnapshot?.();
    if (!activeRun || activeRun.sessionId !== sessionId) return;

    if (activeRun.state === 'running' || activeRun.state === 'decision-blocked') {
      // A legacy Runtime may report a started Session before it can provide a concrete Turn id.
      // Keep the session-scoped recovery identity in that case so the stop fence remains closed.
      if (activeRun.turnId) {
        this.options.runProjection.reconcileRuntimeTurn(activeRun.turnId);
      }
      return;
    }

    // Session.status can remain `started` while an abort/terminal write is settling. The active
    // run snapshot is the authoritative answer for whether the recovered projection is still
    // live; clear the optimistic recovery marker once Runtime says the run is no longer active.
    this.options.runProjection.reconcileRuntimeTurn(undefined);
  }

  async activateSessionReference(
    reference: string,
    options: { silent?: boolean } = {},
  ): Promise<boolean> {
    // A reference resolves to a switch, which is allowed while a turn runs: the
    // previous Session keeps running in the background.
    const normalized = reference.trim();
    const index = Number(normalized);
    if (Number.isInteger(index) && index >= 1) {
      this.options.append(
        'Numeric Session references are deprecated; use /sessions or a Session ID.',
        'warning',
      );
      const indexed = this.options.controller.snapshot().sessions[index - 1];
      if (indexed) {
        await this.activateSessionById(indexed.sessionId);
        return true;
      }
    }
    const session = await this.resolveSessionReference(normalized);
    if (!session) {
      if (!options.silent) {
        this.options.append(
          `Session not found or reference is ambiguous: ${normalized}`,
          'warning',
        );
      }
      return false;
    }
    await this.activateSessionById(session.sessionId);
    return true;
  }

  async activateParentSession(): Promise<void> {
    if (this.isSideModeActive()) {
      await this.toggleSideConversation();
      return;
    }
    if (!this.allowUserSessionNavigation('/parent')) return;
    const current = this.options.controller.snapshot().session;
    if (!current?.parentSessionId) {
      this.options.append('The active session has no parent session.', 'warning');
      return;
    }
    await this.activateSessionById(current.parentSessionId);
  }

  /**
   * Opens a temporary Runtime fork and presents it as a paired side
   * conversation rather than as ordinary Session navigation.
   */
  async startSideSession(input: {
    readonly workspaceDir: string;
  }): Promise<TuiSession | undefined> {
    if (this.isSideModeActive()) {
      // Normally unreachable because the catalog rejects /btw in side mode;
      // kept as a defensive guard for non-catalog callers.
      this.options.append(
        'A side conversation is already open. Press Ctrl+C to return before starting another.',
        'warning',
      );
      this.options.onChanged();
      return undefined;
    }

    const current = this.options.controller.snapshot().session;
    const probe = this.options.runtime.getSessionForkOptions;
    if (!probe) {
      this.options.append(
        'This Runtime does not support side sessions; update Runtime to use /btw.',
        'warning',
      );
      this.options.onChanged();
      return undefined;
    }
    const forkOptions = current?.sessionId
      ? await probe(current.sessionId).catch(() => undefined)
      : undefined;
    const decision = resolveBtwStartDecision({ current, forkOptions });
    if (decision.kind === 'reject') {
      this.options.append(decision.reason, 'warning');
      this.options.onChanged();
      return undefined;
    }

    // Codex semantics: starting a side conversation from the parent view
    // replaces the previous one from the current committed boundary instead
    // of resuming the stale conversation.
    await this.discardSideConversation('replaced');
    let side: TuiSession;
    try {
      side = await this.options.runtime.createSession({
        workspaceDir: current?.workspaceDir ?? input.workspaceDir,
        parentSessionId: decision.parentSessionId,
        visibility: 'hidden',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        title: BTW_SIDE_SESSION_TITLE,
      });
    } catch (error) {
      this.options.observability?.recordSideSessionFailure?.({
        stage: 'create',
        parentSessionId: decision.parentSessionId,
        error,
      });
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      const noBoundary =
        code === 'assistant-not-found' ||
        code === 'assistant-not-settled' ||
        code === 'invalid-boundary';
      this.options.append(
        noBoundary ? BTW_REJECT_NO_BOUNDARY : "Couldn't open a side conversation. Try again.",
        noBoundary ? 'warning' : 'error',
      );
      this.options.onChanged();
      return undefined;
    }

    this.sideConversation = {
      parentSessionId: decision.parentSessionId,
      sideSessionId: side.sessionId,
      activeView: 'parent',
    };
    try {
      await this.activateSessionById(side.sessionId, {
        preserveSideConversation: true,
      });
    } catch (error) {
      this.options.observability?.recordSideSessionFailure?.({
        stage: 'activate',
        parentSessionId: decision.parentSessionId,
        sideSessionId: side.sessionId,
        error,
      });
      this.sideConversation = undefined;
      this.options.onSideConversationChanged?.(undefined);
      await this.options.runtime.deleteSession(side.sessionId).catch(() => undefined);
      this.options.append("Couldn't open a side conversation. Try again.", 'error');
      this.options.onChanged();
      return undefined;
    }

    this.options.onSideSessionOpened?.({
      parentSessionId: decision.parentSessionId,
      sideSessionId: side.sessionId,
    });
    this.options.onChanged();
    return side;
  }

  /** Switches between the paired parent and side projections without ending either one. */
  async toggleSideConversation(): Promise<boolean> {
    const sideConversation = this.sideConversation;
    if (!sideConversation) return false;
    const currentSessionId = this.options.controller.snapshot().session?.sessionId;
    if (
      currentSessionId !== sideConversation.parentSessionId &&
      currentSessionId !== sideConversation.sideSessionId
    ) {
      return false;
    }
    const targetSessionId =
      currentSessionId === sideConversation.sideSessionId
        ? sideConversation.parentSessionId
        : sideConversation.sideSessionId;
    await this.activateSessionById(targetSessionId, {
      preserveSideConversation: true,
    });
    return true;
  }

  /** Stops and destroys the side conversation, then restores the parent projection. */
  async closeSideConversation(exitReason: 'ctrl_c' | 'ctrl_d'): Promise<boolean> {
    const sideConversation = this.sideConversation;
    if (!sideConversation || !this.isSideModeActive()) return false;
    const sideRunId = this.options.currentRunId?.();
    if (this.options.hasLiveRun?.()) {
      const stopped = await this.options.abortForegroundRun?.();
      const active = await this.options.runtime
        .getActiveRun?.(sideConversation.sideSessionId)
        .catch(() => undefined);
      const stillRunning = active?.state === 'running' || active?.state === 'decision-blocked';
      if (stopped !== true || stillRunning || !active) {
        this.options.append(
          "Couldn't close the side conversation because Runtime did not confirm that its response stopped. Press Esc and retry.",
          'warning',
        );
        this.options.onChanged();
        return false;
      }
    }

    await this.activateSessionById(sideConversation.parentSessionId, {
      preserveSideConversation: true,
    });
    this.sideConversation = undefined;
    this.options.onSideConversationChanged?.(undefined);
    this.options.onSideSessionClosed?.({
      parentSessionId: sideConversation.parentSessionId,
      sideSessionId: sideConversation.sideSessionId,
      ...(sideRunId ? { sideRunId } : {}),
      exitReason,
    });
    await this.deleteSideSession(sideConversation.sideSessionId);
    this.options.onChanged();
    return true;
  }

  /** Backward-compatible name used by older callers; this is now a destructive close only. */
  async leaveSideSession(exitReason: 'ctrl_c' | 'ctrl_d' = 'ctrl_c'): Promise<boolean> {
    if (!this.sideConversation) {
      const current = this.options.controller.snapshot().session;
      if (!current || !isSideSession(current) || !current.parentSessionId) return false;
      this.sideConversation = {
        parentSessionId: current.parentSessionId,
        sideSessionId: current.sessionId,
        activeView: 'side',
      };
    }
    return this.closeSideConversation(exitReason);
  }

  private async disposeSideConversation(): Promise<void> {
    // Normal Session navigation must not leave a hidden ephemeral Session
    // behind. Best-effort cleanup is sufficient here because navigation has
    // already chosen a different public projection.
    await this.discardSideConversation('navigation');
  }

  /**
   * Ends a side conversation that is no longer the foreground projection.
   *
   * Mirrors Codex's background discard: interrupt any detached side Turn
   * first, then delete the ephemeral Session. Both steps stay best-effort —
   * the user has already moved on — but the closed telemetry event always
   * fires so open/close stays paired.
   */
  private async discardSideConversation(exitReason: 'navigation' | 'replaced'): Promise<void> {
    const sideConversation = this.sideConversation;
    if (!sideConversation) return;
    this.sideConversation = undefined;
    this.options.onSideConversationChanged?.(undefined);
    try {
      await this.options.abortSessionRun?.(sideConversation.sideSessionId);
    } catch {
      // A side Turn that cannot be interrupted must not block navigation;
      // deletion below still removes the Session record.
    }
    this.options.onSideSessionClosed?.({
      parentSessionId: sideConversation.parentSessionId,
      sideSessionId: sideConversation.sideSessionId,
      exitReason,
    });
    await this.options.runtime.deleteSession(sideConversation.sideSessionId).catch(() => undefined);
  }

  private async deleteSideSession(sideSessionId: string): Promise<void> {
    try {
      await this.options.runtime.deleteSession(sideSessionId);
    } catch {
      try {
        await this.options.runtime.deleteSession(sideSessionId);
      } catch {
        this.options.append(
          'Returned to the main Session, but temporary side-session cleanup failed. Runtime will keep it hidden; retry after reconnecting.',
          'error',
        );
      }
    }
  }

  async activateLatestSession(workspaceDir: string): Promise<boolean> {
    const latest = this.options.controller
      .snapshot()
      .sessions.find(
        (session) =>
          session.workspaceDir === workspaceDir &&
          !session.archived &&
          session.visibility !== 'hidden',
      );
    if (!latest) {
      this.options.append('No saved Session exists in the current workspace.', 'warning');
      return false;
    }
    await this.activateSessionById(latest.sessionId);
    return true;
  }

  async reconcileRuntimeEvent(event: TuiSessionCatalogEvent | TuiRotationEvent): Promise<void> {
    if (this.stopped) return;
    const currentSessionId = this.options.controller.snapshot().session?.sessionId;
    if (event.type === 'rotation.completed') {
      if (currentSessionId !== event.oldSessionId) {
        await this.options.controller.refreshSessionList();
        return;
      }
      await this.options.controller.whenIdle();
      if (this.stopped) return;
      await this.activateSessionById(event.newSessionId);
      return;
    }
    if (event.type === 'session.deleted' && currentSessionId === event.sessionId) {
      await this.options.controller.whenIdle();
      if (this.stopped) return;
      await this.startNew({ endPreviousSession: false, allowDuringLiveRun: true });
      return;
    }
    await this.options.controller.refreshSessionList();
  }

  async archiveCurrentProjection(_sessionId: string): Promise<void> {
    this.sessionSequence += 1;
    this.options.interactionFlow.deactivate();
    if (this.options.switchComposerDraft) {
      await this.options.switchComposerDraft('new-session');
    } else {
      await this.options.composerDraft.discard();
    }
    if (this.stopped) return;
    this.options.featureFlow.resetSessionState();
    this.options.queueFlow.reset();
    this.options.delegationFlow.reset();
    this.options.goalFlow?.reset();
  }

  private async resolveSessionReference(reference: string): Promise<TuiSession | undefined> {
    if (!reference) return undefined;
    const exactLoadedSession = this.options.controller
      .snapshot()
      .sessions.find((session) => session.sessionId === reference);
    if (exactLoadedSession) return exactLoadedSession;
    const matches = new Map<string, TuiSession>();
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (cursor === undefined || !seenCursors.has(cursor)) {
      if (cursor) seenCursors.add(cursor);
      const page = await this.options.runtime.listSessionPage({
        limit: 200,
        includeArchived: true,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      });
      const exact = page.sessions.find((session) => session.sessionId === reference);
      if (exact) return exact;
      for (const session of page.sessions) {
        if (session.sessionId.startsWith(reference)) matches.set(session.sessionId, session);
      }
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return matches.size === 1 ? matches.values().next().value : undefined;
  }

  private async resolveUserNavigableSession(sessionId: string): Promise<TuiSession> {
    const visited = new Set<string>();
    let currentSessionId = sessionId;
    for (let depth = 0; depth < MAX_SUBAGENT_PARENT_DEPTH; depth += 1) {
      if (visited.has(currentSessionId)) {
        throw new Error('Sub-agent Session parent chain is invalid.');
      }
      visited.add(currentSessionId);
      const session = await this.getSession(currentSessionId);
      if (!isTuiInternalSubagentSession(session)) return session;
      if (!session.parentSessionId) {
        if (isTuiBuiltinSubagentSession(session)) {
          throw new Error('Builtin sub-agent Sessions are internal and cannot be opened.');
        }
        throw new Error('Sub-agent Session has no public parent.');
      }
      currentSessionId = session.parentSessionId;
    }
    throw new Error('Sub-agent Session parent chain is invalid.');
  }

  private getSession(sessionId: string): Promise<TuiSession> {
    const snapshot = this.options.controller.snapshot();
    const cached = [snapshot.session, ...snapshot.sessions].find(
      (session) => session?.sessionId === sessionId,
    );
    return cached ? Promise.resolve(cached) : this.options.runtime.getSession(sessionId);
  }

  private allowUserSessionNavigation(command: string): boolean {
    if (!this.options.hasLiveRun?.()) return true;
    this.options.append(`Stop the running turn before using ${command}.`, 'warning');
    this.options.onChanged();
    return false;
  }
}

const MAX_SUBAGENT_PARENT_DEPTH = 32;

function isRuntimeSessionRunning(session: TuiSession | undefined): boolean {
  const status = session?.status?.trim().toLocaleLowerCase();
  return (
    status === 'running' ||
    status === 'processing' ||
    status === 'busy' ||
    status === 'active' ||
    status === 'started' ||
    status === 'in_progress'
  );
}

import type { TuiMessage, TuiSession } from '../../runtime/port.js';
import type { TuiStreamEvent } from '../../runtime/stream-events.js';
import { TuiRunCoordinator } from '../../application/run-coordinator.js';
import { executeTuiInteractiveTurn } from '../../application/interactive-turn-delivery.js';
import { requireTuiInteractiveAgentAccess } from '../../application/login-gate.js';
import {
  formatTuiSubmission,
  toTuiTranscriptAttachments,
} from '../features/composer/attachments.js';
import type { TranscriptStore } from '../transcript/store.js';
import { UNSCOPED_TRANSCRIPT_SESSION } from '../transcript/store.js';
import type { TranscriptAttachment, TranscriptUserPresentation } from '../transcript/model.js';
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../../product-context.js';
import { TuiTurnProjection } from './projection/turn-projection.js';
import type { OptimisticUserCommitMode } from './projection/turn-projection.js';
import { TuiStatusMetricsFlow } from './projection/status-metrics-flow.js';
import { TuiTurnOutputRate } from './projection/turn-output-rate.js';
import {
  cloneAccountStatus,
  createTuiActiveTurn,
  createTuiTurnId,
  latestHistoryMessageId,
  numericTuiRunErrorCode,
  resolveCurrentSession,
  resolveTuiSessionFromState,
  requiresQueueFallback,
  requireRuntimeMethod,
  sortSessions,
  upsertSession,
  type TuiActiveTurn,
  type TuiChatRuntimeLike,
  type TuiSubmitStatus,
} from './chat-controller-support.js';
import { resolveTuiRuntimeFailure } from './runtime/runtime-error-presentation.js';
import {
  isTuiStreamFailureRetryable,
  resolveTuiSessionFailureState,
} from './chat-controller-failure.js';
import { toErrorMessage } from './support.js';
import { formatTuiActionFailure } from '../../user-facing-failure.js';
import type {
  CreateTuiChatControllerOptions,
  TuiChatSnapshot,
  TuiSettledTurn,
  TuiSubmitOptions,
} from './chat-controller-types.js';
import { abortTuiChatTurn } from './run/chat-turn-abort.js';
import { TuiRuntimeTurnSettlement } from './run/runtime-turn-settlement.js';
import { createTuiSettledTurn } from './run/turn-settlement.js';

export type { TuiSubmitStatus } from './chat-controller-support.js';
export type {
  CreateTuiChatControllerOptions,
  TuiChatSnapshot,
  TuiChatStatus,
  TuiSettledTurn,
  TuiSubmitOptions,
} from './chat-controller-types.js';

/**
 * How many Sessions keep their cells in the transcript store. The visible one is
 * never evicted; the others are dropped oldest first, and closing a tab releases
 * its Session immediately, so retention follows the tabs the user keeps open.
 */
const MAX_RETAINED_TRANSCRIPT_SESSIONS = 6;

function backgroundTurnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function streamEventTimestamp(event: TuiStreamEvent): number | undefined {
  return 'timestamp' in event && typeof event.timestamp === 'number' ? event.timestamp : undefined;
}

export class TuiChatController {
  private readonly runtime: TuiChatRuntimeLike;
  private readonly transcript: TranscriptStore;
  private readonly workspaceDir: string;
  private readonly version: string;
  private readonly defaultAgentName: string;
  private readonly createTurnId: () => string;
  private readonly runCoordinator: TuiRunCoordinator;
  private readonly retirementWarningTimeoutMs: number;
  private readonly now: () => number;
  private readonly onChange?: (snapshot: TuiChatSnapshot) => void;
  private readonly onTurnAccepted?: (turnId: string) => void;
  private readonly onUserSubmissionProjected?: () => void;
  private readonly writeAutomationResult?: CreateTuiChatControllerOptions['writeAutomationResult'];
  private readonly turnProjection: TuiTurnProjection;
  private readonly statusMetrics: TuiStatusMetricsFlow;
  private readonly outputRate: TuiTurnOutputRate;
  readonly runtimeTurnSettlement: TuiRuntimeTurnSettlement;
  private state: TuiChatSnapshot = { status: 'idle', sessions: [] };
  private activeTurn?: TuiActiveTurn;
  private sessionCreation?: Promise<TuiSession>;
  private sessionCreationSequence = 0;
  private sessionCatalogRefreshSequence = 0;
  private sessionProjectionSequence = 0;
  private durableMessageAnchor?: string;
  private pendingHistoryRefresh = false;
  private readonly retainedTranscriptSessions = new Set<string>();
  private readonly backgroundTurnProjections = new Map<string, TuiTurnProjection>();
  private readonly backgroundTurnAnchors = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private notificationBatchDepth = 0;
  private notificationPending = false;

  constructor(private readonly options: CreateTuiChatControllerOptions) {
    this.runtime = options.runtime;
    this.transcript = options.transcript;
    this.workspaceDir = options.workspaceDir;
    this.version = options.version ?? 'development';
    this.defaultAgentName = options.defaultAgentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME;
    this.createTurnId = options.createTurnId ?? createTuiTurnId;
    this.runCoordinator = options.runCoordinator ?? new TuiRunCoordinator(options.runtime);
    this.retirementWarningTimeoutMs = options.retirementWarningTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.outputRate = new TuiTurnOutputRate({ now: this.now });
    this.onChange = options.onChange;
    this.onTurnAccepted = options.onTurnAccepted;
    this.onUserSubmissionProjected = options.onUserSubmissionProjected;
    this.writeAutomationResult = options.writeAutomationResult
      ? async (result) => {
          await options.writeAutomationResult?.(result);
          options.onAutomationResultPublished?.(result);
        }
      : undefined;
    this.turnProjection = new TuiTurnProjection({
      transcript: this.transcript,
      now: this.now,
      onChange: () => this.notify(),
      onTodoChange: options.onTodoChange,
    });
    this.runtimeTurnSettlement = new TuiRuntimeTurnSettlement({
      turnProjection: this.turnProjection,
      outputRate: this.outputRate,
      transcript: this.transcript,
      currentSessionId: () => this.state.session?.sessionId,
      updateState: (patch) => this.updateState(patch),
      writeAutomationResult: this.writeAutomationResult,
    });
    this.statusMetrics = new TuiStatusMetricsFlow({
      runtime: this.runtime,
      currentSessionId: () => this.state.session?.sessionId,
      currentAccount: () => this.state.account,
      currentModelLabel: () => selectedModelLabel(this.state.session?.model),
      apply: (patch) => this.updateState(patch),
    });
  }

  snapshot(): TuiChatSnapshot {
    return {
      ...this.state,
      sessions: this.state.sessions.map((session) => ({ ...session })),
      session: this.state.session ? { ...this.state.session } : undefined,
      account: cloneAccountStatus(this.state.account),
      sessionUsage: this.state.sessionUsage ? { ...this.state.sessionUsage } : undefined,
      sessionCost: this.state.sessionCost ? { ...this.state.sessionCost } : undefined,
      lastSettledTurn: this.state.lastSettledTurn ? { ...this.state.lastSettledTurn } : undefined,
    };
  }
  async initialize(): Promise<void> {
    this.updateState({
      status: 'starting',
      error: undefined,
      lastSettledTurn: undefined,
      sessionUsage: undefined,
      sessionCost: undefined,
      contextSnapshot: undefined,
    });
    const [sessionsResult] = await Promise.allSettled([
      this.runtime.listSessions?.(this.defaultAgentName),
      this.statusMetrics.refreshAccount(),
    ]);
    const sessions =
      sessionsResult.status === 'fulfilled' && sessionsResult.value
        ? sortSessions(sessionsResult.value)
        : [];
    const errors = [sessionsResult].flatMap((result) =>
      result.status === 'rejected'
        ? [
            formatTuiActionFailure(result.reason, {
              summary: "Couldn't load sessions.",
              nextStep: 'Retry.',
            }),
          ]
        : [],
    );
    this.updateState({
      status: errors.length > 0 && sessions.length === 0 ? 'error' : 'idle',
      sessions,
      error: errors.length > 0 ? errors.join('\n') : undefined,
    });
  }

  async refreshSessionList(): Promise<void> {
    const listSessions = requireRuntimeMethod(this.runtime, 'listSessions');
    const refreshSequence = ++this.sessionCatalogRefreshSequence;
    const sessions = sortSessions(await listSessions(this.defaultAgentName));
    if (refreshSequence !== this.sessionCatalogRefreshSequence) return;
    const session = resolveCurrentSession(sessions, this.state.session);
    const failureState = resolveTuiSessionFailureState(session);
    this.updateState({
      status: this.activeTurn ? this.state.status : failureState.status,
      sessions,
      session,
      error: this.activeTurn ? this.state.error : failureState.error,
      errorRetryable: this.activeTurn ? this.state.errorRetryable : failureState.errorRetryable,
    });
  }

  whenIdle(): Promise<void> {
    if (!this.activeTurn && !this.runCoordinator.retiringTurnId()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  /**
   * Open `sessionId` in the pane.
   *
   * `rebuild` forces the pane to be projected from saved messages again, for a
   * caller that rewrote the Session's history (a rewind): the cells kept for it
   * describe content that no longer exists, so adopting them would show it.
   */
  async loadSessionProjection(
    sessionId: string,
    options: { rebuild?: boolean } = {},
  ): Promise<void> {
    if (options.rebuild) this.releaseSessionTranscript(sessionId);
    this.detachActiveTurnForSessionSwitch();
    this.invalidateSessionCatalogRefresh();
    this.invalidateSessionCreation();
    const getSession = requireRuntimeMethod(this.runtime, 'getSession');
    const getMessages = requireRuntimeMethod(this.runtime, 'getMessages');
    const projectionSequence = ++this.sessionProjectionSequence;
    this.updateState({
      status: 'starting',
      error: undefined,
      lastSettledTurn: undefined,
      sessionUsage: undefined,
      sessionCost: undefined,
      contextSnapshot: undefined,
    });
    try {
      const [storedSession, messages] = await Promise.all([
        getSession(sessionId),
        getMessages(sessionId),
      ]);
      if (projectionSequence !== this.sessionProjectionSequence) return;
      const session = storedSession.archived
        ? await this.setSessionArchived(storedSession.sessionId, false)
        : storedSession;
      if (projectionSequence !== this.sessionProjectionSequence) return;
      this.projectSessionIntoPane(sessionId, messages);
      this.durableMessageAnchor = latestHistoryMessageId(messages);
      if (projectionSequence !== this.sessionProjectionSequence) return;
      this.updateState({
        ...resolveTuiSessionFailureState(session),
        session,
        sessions: upsertSession(this.state.sessions, session),
      });
      void this.statusMetrics.refresh(session.sessionId);
    } catch (error) {
      if (projectionSequence !== this.sessionProjectionSequence) return;
      this.updateState({
        status: 'error',
        error: formatTuiActionFailure(error, {
          summary: "Couldn't open this session.",
          nextStep: 'Retry.',
          preservation: 'Its saved messages are unchanged.',
        }),
      });
      throw error;
    }
  }

  /**
   * Point the pane at `sessionId` and project its history into it.
   *
   * A Session this store has already projected is adopted: it keeps the cells the
   * pane already showed — including a turn that is still streaming — and only its
   * durable content is reconciled. Only a Session that was never projected (or was
   * released) is rebuilt from scratch, because re-projecting a Session that is
   * still on screen would drop the live tail of its running turn.
   */
  private projectSessionIntoPane(sessionId: string, messages: readonly TuiMessage[]): void {
    this.transcript.setActiveSession(sessionId);
    // This Session is the pane now, so the visible projection owns its turn again.
    this.releaseBackgroundTurnProjection(sessionId);
    if (this.retainedTranscriptSessions.has(sessionId)) {
      this.transcript.replaceDurableProjection(() => this.turnProjection.hydrateHistory(messages));
      return;
    }
    this.turnProjection.clearTodos();
    this.transcript.clear(sessionId);
    this.turnProjection.hydrateHistory(messages);
    this.retainSessionTranscript(sessionId);
  }

  /** Mark a Session as projected here, evicting the oldest pane past the cap. */
  private retainSessionTranscript(sessionId: string): void {
    this.retainedTranscriptSessions.add(sessionId);
    while (this.retainedTranscriptSessions.size > MAX_RETAINED_TRANSCRIPT_SESSIONS) {
      const victim = [...this.retainedTranscriptSessions].find(
        (id) => id !== this.transcript.activeSessionId,
      );
      if (!victim) return;
      this.releaseSessionTranscript(victim);
    }
  }

  /**
   * Make a freshly created Session the one the pane belongs to. When the pane had
   * no Session yet (first turn of a new conversation), the cells it already wrote —
   * the user's message being the important one — become this Session's cells, so a
   * later switch away and back still shows them.
   */
  private claimPaneForSession(sessionId: string): void {
    if (this.transcript.activeSessionId === UNSCOPED_TRANSCRIPT_SESSION) {
      this.transcript.moveSession(UNSCOPED_TRANSCRIPT_SESSION, sessionId);
    }
    this.transcript.setActiveSession(sessionId);
    this.retainSessionTranscript(sessionId);
  }

  /** Whether this store keeps a pane for `sessionId` (i.e. its tab was opened). */
  retainsTranscript(sessionId: string): boolean {
    return this.retainedTranscriptSessions.has(sessionId);
  }

  /**
   * Forget the cells kept for a Session. Called when its tab closes and when it is
   * archived or deleted: a Session that comes back is projected from durable
   * history again, so nothing stale can outlive it.
   */
  releaseSessionTranscript(sessionId: string): void {
    this.releaseBackgroundTurnProjection(sessionId);
    this.retainedTranscriptSessions.delete(sessionId);
    this.transcript.dropSession(sessionId);
  }

  /**
   * The projection a background Session's live turn writes through. It targets that
   * Session's pane and nothing else: a background turn never touches the visible
   * Session's state — usage, cost, output throughput, the todo panel and the
   * interaction panel all belong to the Session on screen.
   */
  private backgroundTurnProjection(sessionId: string): TuiTurnProjection {
    const existing = this.backgroundTurnProjections.get(sessionId);
    if (existing) return existing;
    const projection = new TuiTurnProjection({
      transcript: this.transcript.scoped(sessionId),
      now: this.now,
      onChange: () => this.notify(),
    });
    this.backgroundTurnProjections.set(sessionId, projection);
    return projection;
  }

  /**
   * Anchor a background turn in its own pane, once per Session and Turn: the cells a
   * watcher streams into need a turn to belong to, and the visible projection is not
   * the one writing them.
   */
  beginBackgroundTurn(sessionId: string, turnId: string, startedAtMs: number): void {
    const key = backgroundTurnKey(sessionId, turnId);
    if (this.backgroundTurnAnchors.has(key)) return;
    this.backgroundTurnAnchors.add(key);
    this.backgroundTurnProjection(sessionId).beginTurn(turnId, startedAtMs);
    this.notify();
  }

  /**
   * Apply one event of a turn whose Session is not the one on screen. A Session that
   * became visible mid-turn goes back through the visible projection, so a turn never
   * has two writers.
   */
  applyBackgroundTurnEvent(
    sessionId: string,
    turnId: string,
    event: TuiStreamEvent,
  ): string | undefined {
    if (this.state.session?.sessionId === sessionId) {
      return this.applyRuntimeTurnEvent(turnId, event);
    }
    try {
      this.beginBackgroundTurn(sessionId, turnId, streamEventTimestamp(event) ?? this.now());
      return this.backgroundTurnProjection(sessionId).applyStreamEvent(turnId, event);
    } catch (error) {
      return formatTuiActionFailure(error, {
        summary: "Couldn't show a background Session's output.",
        nextStep: 'Reopen that Session to load its saved messages.',
        preservation: 'Its saved messages are unchanged.',
      });
    }
  }

  /** Settle a background turn in its own pane, leaving the visible Session alone. */
  settleBackgroundTurn(
    sessionId: string,
    turnId: string,
    status: TuiSettledTurn['status'],
    durationMs?: number,
  ): void {
    if (this.state.session?.sessionId === sessionId) return;
    const projection = this.backgroundTurnProjections.get(sessionId);
    this.backgroundTurnAnchors.delete(backgroundTurnKey(sessionId, turnId));
    if (!projection) return;
    projection.markTurn(turnId, status, durationMs);
    projection.clearTurn(turnId);
    this.notify();
  }

  private releaseBackgroundTurnProjection(sessionId: string): void {
    this.backgroundTurnProjections.delete(sessionId);
    for (const key of [...this.backgroundTurnAnchors]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.backgroundTurnAnchors.delete(key);
    }
  }

  async refreshCurrentSessionHistory(): Promise<void> {
    this.assertNoActiveTurn('refreshing session history');
    this.invalidateSessionCatalogRefresh();
    const current = this.requireCurrentSession();
    const getMessages = requireRuntimeMethod(this.runtime, 'getMessages');
    const projectionSequence = ++this.sessionProjectionSequence;
    this.updateState({ status: 'starting', error: undefined });
    try {
      const [session, messages] = await Promise.all([
        this.runtime.getSession?.(current.sessionId) ?? current,
        getMessages(current.sessionId),
      ]);
      if (projectionSequence !== this.sessionProjectionSequence) return;
      this.transcript.replaceDurableProjection(() => this.turnProjection.hydrateHistory(messages));
      this.durableMessageAnchor = latestHistoryMessageId(messages);
      if (projectionSequence !== this.sessionProjectionSequence) return;
      this.updateState({
        ...resolveTuiSessionFailureState(session),
        session,
        sessions: upsertSession(this.state.sessions, session),
      });
      void this.statusMetrics.refresh(session.sessionId);
    } catch (error) {
      if (projectionSequence !== this.sessionProjectionSequence) return;
      this.updateState({
        status: 'error',
        error: formatTuiActionFailure(error, {
          summary: "Couldn't refresh this session.",
          nextStep: 'Reopen it to retry.',
        }),
      });
      throw error;
    }
  }

  waitForCurrentSession(): Promise<TuiSession> {
    if (this.state.session) return Promise.resolve(this.state.session);
    if (this.activeTurn || this.sessionCreation) return this.ensureSession();
    return Promise.reject(new Error('No active session.'));
  }

  async renameCurrentSession(title: string): Promise<TuiSession> {
    const session = this.requireCurrentSession();
    return this.renameSession(session.sessionId, title);
  }

  async renameSession(sessionId: string, title: string): Promise<TuiSession> {
    this.assertNoActiveTurn('renaming a session');
    this.invalidateSessionCatalogRefresh();
    const nextTitle = title.trim();
    if (!nextTitle) throw new Error('Session title cannot be empty.');
    const existing = await this.resolveSession(sessionId);
    const renameSession = requireRuntimeMethod(this.runtime, 'renameSession');
    const renamed = {
      ...existing,
      ...(await renameSession(sessionId, nextTitle)),
      title: nextTitle,
    };
    this.updateState({
      session: this.state.session?.sessionId === sessionId ? renamed : this.state.session,
      sessions: renamed.archived
        ? this.state.sessions.filter((session) => session.sessionId !== sessionId)
        : upsertSession(this.state.sessions, renamed),
      error: undefined,
    });
    return renamed;
  }

  async archiveCurrentSession(): Promise<void> {
    const session = this.requireCurrentSession();
    await this.setSessionArchived(session.sessionId, true);
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<TuiSession> {
    this.assertNoActiveTurn(archived ? 'archiving a session' : 'restoring a session');
    this.invalidateSessionCatalogRefresh();
    const existing = await this.resolveSession(sessionId);
    const archiveSession = requireRuntimeMethod(this.runtime, 'archiveSession');
    await archiveSession(sessionId, archived);
    const session = archived
      ? { ...existing, archived: true }
      : { ...(await this.resolveSession(sessionId, true)), archived: false };
    const isCurrent = this.state.session?.sessionId === sessionId;
    if (archived) {
      // An archived Session leaves the bar, and with it the store's retention.
      this.releaseSessionTranscript(sessionId);
    }
    if (archived && isCurrent) {
      this.turnProjection.clearTodos();
      this.durableMessageAnchor = undefined;
    }
    this.updateState({
      status: 'idle',
      session: archived && isCurrent ? undefined : this.state.session,
      sessions: archived
        ? this.state.sessions.filter((item) => item.sessionId !== sessionId)
        : upsertSession(this.state.sessions, session),
      error: undefined,
      ...(archived && isCurrent ? { lastSettledTurn: undefined } : {}),
    });
    return session;
  }

  /**
   * Delete a Session the way the runtime does: rows and canonical history files
   * are removed, and children are re-parented. There is no trash to restore
   * from, so callers confirm first.
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.assertNoActiveTurn('deleting a session');
    this.invalidateSessionCatalogRefresh();
    const deleteSessionMethod = requireRuntimeMethod(this.runtime, 'deleteSession');
    await deleteSessionMethod(sessionId);
    const isCurrent = this.state.session?.sessionId === sessionId;
    this.releaseSessionTranscript(sessionId);
    if (isCurrent) {
      this.turnProjection.clearTodos();
      this.durableMessageAnchor = undefined;
    }
    this.updateState({
      status: 'idle',
      session: isCurrent ? undefined : this.state.session,
      sessions: this.state.sessions.filter((item) => item.sessionId !== sessionId),
      error: undefined,
      ...(isCurrent ? { lastSettledTurn: undefined } : {}),
    });
  }

  async submit(rawContent: string, options: TuiSubmitOptions = {}): Promise<TuiSubmitStatus> {
    const content = rawContent.trim();
    const displayContent = options.displayContent?.trim() ?? content;
    const attachments = options.attachments ?? [];
    const isRetryContinuation = options.clientIntent === 'retry-continuation';
    if (!content && attachments.length === 0 && !isRetryContinuation) return 'ignored';
    if (this.activeTurn || this.runCoordinator.activeTurnId()) {
      throw new Error('A turn is already running in this or another Session.');
    }
    if (this.runCoordinator.retiringTurnId()) {
      throw new Error('The previous run is still stopping.');
    }
    const turnId = this.createTurnId();
    const activeTurn = createTuiActiveTurn(turnId);
    let admittedSessionId: string | undefined;
    let resolvedSessionId: string | undefined;
    let recoveringPausedQueue = false;
    const onQueuePaused = options.onQueuePaused;
    this.activeTurn = activeTurn;
    const optimisticCell = options.optimisticRequestId
      ? this.transcript.get(`optimistic:user:${options.optimisticRequestId}`)
      : undefined;
    if (options.optimisticRequestId) {
      this.turnProjection.removeOptimisticUserMessage(options.optimisticRequestId);
    }
    const timestamp = optimisticCell?.createdAtMs ?? this.now();
    this.outputRate.beginTurn(turnId);
    if (!isRetryContinuation) {
      this.transcript.upsert({
        id: `user:${turnId}`,
        kind: 'user',
        status: 'pending',
        content: formatTuiSubmission(displayContent, attachments),
        ...(attachments.length > 0 ? { attachments: toTuiTranscriptAttachments(attachments) } : {}),
        turnId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
    }
    this.updateState({
      activeTurnId: turnId,
      lastSettledTurn: undefined,
      outputTokensPerSecond: undefined,
      outputTokensPerSecondEstimated: undefined,
      error: undefined,
      errorRetryable: undefined,
    });
    if (!optimisticCell && !isRetryContinuation) this.onUserSubmissionProjected?.();

    try {
      await this.requireLoginForAgentAction();
    } catch (error) {
      this.turnProjection.removeTurn(turnId);
      activeTurn.sessionDeliveryAbort.abort();
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
        this.turnProjection.clearTurn(turnId);
        this.updateState({
          status: 'idle',
          activeTurnId: undefined,
          cancelling: false,
          error: undefined,
        });
      }
      this.resolveIdleWaiters();
      throw error;
    }

    try {
      if (this.activeTurn !== activeTurn || activeTurn.cancelling) return 'cancelled';
      this.turnProjection.beginTurn(turnId, timestamp);
      const session = this.ensureSession(options.onSessionResolved).then(async (resolved) => {
        resolvedSessionId = resolved.sessionId;
        await options.beforeTurnAdmission?.(resolved.sessionId);
        if (this.activeTurn === activeTurn && this.runCoordinator.activeTurnId() === turnId) {
          this.updateState({
            status: 'running',
            session: resolved,
            activeTurnId: turnId,
            error: undefined,
          });
        }
        return resolved;
      });
      const result = await executeTuiInteractiveTurn({
        request: {
          turnId,
          session,
          content,
          workspace: this.workspaceDir,
          version: this.version,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(options.clientIntent ? { clientIntent: options.clientIntent } : {}),
          ...(options.reviewRequest ? { reviewRequest: options.reviewRequest } : {}),
          ...(onQueuePaused
            ? {
                onQueuePaused: (sessionId, signal) => {
                  recoveringPausedQueue = true;
                  return onQueuePaused(sessionId, signal);
                },
              }
            : {}),
          ...(this.writeAutomationResult ? { policy: { requireAnswer: true } } : {}),
        },
        coordinator: this.runCoordinator,
        isActive: () => this.activeTurn === activeTurn && !activeTurn.cancelling,
        onSessionEvent: (event) => {
          const failure = this.applyRuntimeTurnEvent(turnId, event);
          if (failure) {
            this.failTurnState(failure, isTuiStreamFailureRetryable(event), turnId);
          }
        },
        onRunAccepted: () => {
          admittedSessionId = resolvedSessionId;
          if (resolvedSessionId) options.onRuntimeAccepted?.(resolvedSessionId);
          this.onTurnAccepted?.(turnId);
        },
        ...(this.writeAutomationResult
          ? {
              onResult: async (execResult) => {
                if (
                  activeTurn.retracted ||
                  execResult.error?.code === 'PAUSED_QUEUE_SEND_CANCELLED' ||
                  (!recoveringPausedQueue && requiresQueueFallback(execResult.error?.code))
                ) {
                  return;
                }
                await this.writeAutomationResult?.(execResult);
              },
            }
          : {}),
      });

      if (activeTurn.retracted) {
        this.turnProjection.removeTurn(turnId);
        if (this.activeTurn === activeTurn) {
          this.updateState({
            status: 'idle',
            activeTurnId: undefined,
            cancelling: false,
            error: undefined,
          });
        }
        return 'retracted';
      }

      if (result.status === 'cancelled') {
        if (this.activeTurn !== activeTurn) return 'cancelled';
        this.turnProjection.markTurn(turnId, 'cancelled');
        if (result.outcome.status === 'cancelled') {
          this.turnProjection.recordTerminalDuration(
            turnId,
            'cancelled',
            result.outcome.durationMs,
          );
        }
        if (this.activeTurn === activeTurn) {
          this.settleTurnState(turnId, 'cancelled');
        }
        return 'cancelled';
      }
      if (result.status === 'succeeded') {
        if (this.activeTurn !== activeTurn) return 'succeeded';
        this.turnProjection.markTurn(turnId, 'succeeded');
        if (result.outcome.status === 'succeeded') {
          this.turnProjection.recordTerminalDuration(
            turnId,
            'succeeded',
            result.outcome.durationMs,
            this.outputRate.current(),
            this.outputRate.currentEstimated(),
          );
        }
        if (this.activeTurn === activeTurn) {
          this.settleTurnState(turnId, 'succeeded');
        }
        return 'succeeded';
      }
      if (result.status === 'awaiting-user-continuation') {
        if (this.activeTurn !== activeTurn) return 'blocked';
        this.turnProjection.markTurn(turnId, 'blocked');
        if (this.activeTurn === activeTurn) {
          this.settleTurnState(turnId, 'blocked');
        }
        return 'blocked';
      }
      if (result.outcome.error?.code === 'PAUSED_QUEUE_SEND_CANCELLED') {
        this.turnProjection.removeTurn(turnId);
        if (this.activeTurn === activeTurn)
          this.updateState({
            status: 'idle',
            activeTurnId: undefined,
            cancelling: false,
            error: undefined,
          });
        return 'draft-kept';
      }
      if (!recoveringPausedQueue && requiresQueueFallback(result.outcome.error?.code)) {
        if (this.activeTurn !== activeTurn) return 'queue-required';
        this.turnProjection.removeTurn(turnId);
        if (this.activeTurn === activeTurn) {
          this.updateState({
            status: 'idle',
            activeTurnId: undefined,
            cancelling: false,
            error: undefined,
          });
        }
        return 'queue-required';
      }
      if (this.activeTurn === activeTurn) {
        const failure = resolveTuiRuntimeFailure(
          result.error ?? 'Run failed.',
          numericTuiRunErrorCode(result.outcome.error?.code),
          { retryable: result.outcome.error?.retryable },
        );
        this.failTurn(turnId, failure.content, failure.retryable);
      }
      return 'failed';
    } catch (error) {
      if (this.activeTurn === activeTurn) {
        const failure = resolveTuiRuntimeFailure(toErrorMessage(error));
        this.failTurn(turnId, failure.content, failure.retryable);
      }
      return 'failed';
    } finally {
      activeTurn.sessionDeliveryAbort.abort();
      if (this.activeTurn === activeTurn) {
        const sessionId = this.state.session?.sessionId;
        const refreshHistory = Boolean(sessionId && this.pendingHistoryRefresh);
        const metadataSessionId =
          admittedSessionId ?? (options.clientIntent ? resolvedSessionId : undefined);
        if (!refreshHistory && metadataSessionId) {
          await this.refreshSessionMetadata(metadataSessionId).catch(() => undefined);
        }
        if (this.activeTurn === activeTurn) {
          this.activeTurn = undefined;
          this.turnProjection.clearTurn(turnId);
          if (sessionId && refreshHistory) {
            this.pendingHistoryRefresh = false;
            await this.refreshCurrentSessionHistory().catch(() => undefined);
          }
          if (sessionId) void this.statusMetrics.refresh(sessionId);
        }
      }
      this.resolveIdleWaiters();
    }
  }

  async refreshSessionMetadata(sessionId: string): Promise<void> {
    const getSession = this.runtime.getSession?.bind(this.runtime);
    if (!getSession || this.state.session?.sessionId !== sessionId) return;
    const session = await getSession(sessionId);
    if (this.state.session?.sessionId !== sessionId) return;
    this.updateState({
      session,
      sessions: upsertSession(this.state.sessions, session),
    });
  }

  async reconcileOwnerHistory(retractActiveTurn = false): Promise<boolean> {
    if (retractActiveTurn && this.activeTurn) {
      this.activeTurn.retracted = true;
      this.pendingHistoryRefresh = true;
      this.turnProjection.removeTurn(this.activeTurn.id);
      return false;
    }
    if (this.activeTurn) {
      this.pendingHistoryRefresh = true;
      return false;
    }
    await this.refreshCurrentSessionHistory();
    return true;
  }

  async abort(): Promise<boolean> {
    return abortTuiChatTurn({
      activeTurn: this.activeTurn,
      coordinator: this.runCoordinator,
      resultDeliveryEnabled: Boolean(this.writeAutomationResult),
      retirementWarningTimeoutMs: this.retirementWarningTimeoutMs,
      invalidateSessionCreation: () => this.invalidateSessionCreation(),
      markCancelled: (turnId) => this.turnProjection.markTurn(turnId, 'cancelled'),
      settledTurn: (turnId, status) =>
        createTuiSettledTurn(this.state.session?.sessionId, turnId, status),
      isCurrent: (turn) => this.activeTurn === turn,
      clearCurrent: (turn) => {
        this.activeTurn = undefined;
        this.turnProjection.clearTurn(turn.id);
      },
      apply: (patch) => this.updateState(patch),
      currentRetiringTurnId: () => this.state.retiringTurnId,
      resolveIdleWaiters: () => this.resolveIdleWaiters(),
    });
  }

  hasInProcessRun(): boolean {
    return Boolean(this.activeTurn || this.runCoordinator.activeTurnId());
  }

  beginRuntimeTurn(turnId: string, timestamp: number): void {
    this.outputRate.beginTurn(turnId);
    this.turnProjection.beginTurn(turnId, timestamp);
    if (
      this.state.lastSettledTurn ||
      this.state.outputTokensPerSecond !== undefined ||
      this.state.outputTokensPerSecondEstimated !== undefined
    ) {
      this.updateState({
        lastSettledTurn: undefined,
        outputTokensPerSecond: undefined,
        outputTokensPerSecondEstimated: undefined,
      });
    }
  }

  projectOptimisticUserMessage(
    requestId: string,
    content: string,
    timestamp: number,
    attachments: readonly TranscriptAttachment[] = [],
    userPresentation?: TranscriptUserPresentation,
  ): void {
    this.turnProjection.projectOptimisticUserMessage(
      requestId,
      content,
      timestamp,
      attachments,
      userPresentation,
    );
    this.onUserSubmissionProjected?.();
  }

  removeOptimisticUserMessage(requestId: string): void {
    this.turnProjection.removeOptimisticUserMessage(requestId);
  }

  acceptOptimisticUserMessage(
    requestId: string,
    turnId: string,
    timestamp: number,
    commitMode: OptimisticUserCommitMode = 'immediate',
  ): void {
    this.turnProjection.acceptOptimisticUserMessage(requestId, turnId, timestamp, commitMode);
  }

  applyRuntimeTurnEvent(turnId: string, event: TuiStreamEvent): string | undefined {
    return this.batchNotifications(() => {
      if (event.type === 'message' && event.message.id)
        this.durableMessageAnchor = event.message.id;
      const outputTokensPerSecond = this.outputRate.apply(turnId, event);
      const outputTokensPerSecondEstimated = this.outputRate.currentEstimated();
      if (
        !Object.is(outputTokensPerSecond, this.state.outputTokensPerSecond) ||
        !Object.is(outputTokensPerSecondEstimated, this.state.outputTokensPerSecondEstimated)
      ) {
        this.updateState({ outputTokensPerSecond, outputTokensPerSecondEstimated });
      }
      return this.turnProjection.applyStreamEvent(turnId, event);
    });
  }
  latestDurableMessageId(): string | undefined {
    return this.durableMessageAnchor;
  }

  startNewSession(markSessionCleared = true): void {
    if (this.runCoordinator.retiringTurnId()) {
      throw new Error('Stop the running turn before starting a new session.');
    }
    this.detachActiveTurnForSessionSwitch();
    this.invalidateSessionCreation();
    this.invalidateSessionCatalogRefresh();
    this.sessionProjectionSequence += 1;
    this.turnProjection.clearTodos();
    this.outputRate.reset();
    // The new conversation has no Session yet: empty the pane's unscoped cells and
    // leave the Session being left with its cells, so switching back to it shows
    // what it showed before.
    this.transcript.clear(UNSCOPED_TRANSCRIPT_SESSION);
    this.transcript.setActiveSession(UNSCOPED_TRANSCRIPT_SESSION);
    this.durableMessageAnchor = undefined;
    if (markSessionCleared) this.options.onSessionLifecycle?.();
    this.state = {
      status: 'idle',
      sessions: this.state.sessions,
      account: this.state.account,
    };
    this.notify();
  }

  async ensureSession(onResolved?: (sessionId: string) => void): Promise<TuiSession> {
    if (this.state.session) {
      onResolved?.(this.state.session.sessionId);
      return this.state.session;
    }
    if (this.sessionCreation) {
      const session = await this.sessionCreation;
      onResolved?.(session.sessionId);
      return session;
    }
    this.invalidateSessionCatalogRefresh();
    const creationSequence = ++this.sessionCreationSequence;
    const projectionSequence = this.sessionProjectionSequence;
    this.updateState({ status: 'starting', error: undefined });
    const creation = this.runtime
      .createSession({ workspaceDir: this.workspaceDir })
      .then((session) => {
        this.options.onSessionLifecycle?.(session.sessionId);
        onResolved?.(session.sessionId);
        if (
          creationSequence !== this.sessionCreationSequence ||
          projectionSequence !== this.sessionProjectionSequence
        ) {
          return session;
        }
        this.updateState({
          status: 'idle',
          session,
          sessions: upsertSession(this.state.sessions, session),
        });
        this.claimPaneForSession(session.sessionId);
        return session;
      })
      .finally(() => {
        if (this.sessionCreation === creation) this.sessionCreation = undefined;
      });
    this.sessionCreation = creation;
    return creation;
  }

  private invalidateSessionCreation(): void {
    this.sessionCreationSequence += 1;
    this.sessionCreation = undefined;
  }

  private invalidateSessionCatalogRefresh(): void {
    this.sessionCatalogRefreshSequence += 1;
  }

  refreshAccountStatusNow(): void {
    void this.statusMetrics.refreshAccount(this.state.session?.sessionId);
  }

  refreshStatusMetricsNow(): void {
    this.statusMetrics.refreshCurrent();
  }

  refreshSessionUsageNow(sessionId: string): void {
    if (this.state.session?.sessionId !== sessionId) return;
    void this.statusMetrics.refreshSessionUsage(sessionId);
    void this.statusMetrics.refreshContext(sessionId);
  }

  /** Recomputes the session-tree cost (for example when a sub-agent finishes). */
  refreshSessionCostNow(): void {
    const sessionId = this.state.session?.sessionId;
    if (!sessionId) return;
    void this.statusMetrics.refreshSessionCost(sessionId);
  }

  async requireLoginForAgentAction(): Promise<void> {
    await requireTuiInteractiveAgentAccess(this.runtime, this.state.session?.sessionId, (account) =>
      this.updateState({ account }),
    );
  }

  private assertNoActiveTurn(action: string): void {
    if (this.activeTurn || this.runCoordinator.retiringTurnId()) {
      throw new Error(`Stop the running turn before ${action}.`);
    }
  }

  private detachActiveTurnForSessionSwitch(): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn) return;
    activeTurn.sessionDeliveryAbort.abort();
    this.runCoordinator.detachActiveRun(activeTurn.id);
    this.activeTurn = undefined;
    this.pendingHistoryRefresh = false;
    this.updateState({
      status: 'idle',
      activeTurnId: undefined,
      cancelling: false,
      error: undefined,
    });
    this.resolveIdleWaiters();
  }

  private requireCurrentSession(): TuiSession {
    if (!this.state.session) throw new Error('No active session.');
    return this.state.session;
  }

  private resolveSession(sessionId: string, forceRefresh = false): Promise<TuiSession> {
    return resolveTuiSessionFromState(this.runtime, this.state, sessionId, forceRefresh);
  }

  private failTurn(turnId: string, message: string, retryable?: boolean): void {
    this.turnProjection.failTurn(turnId, message);
    this.failTurnState(message, retryable, turnId);
  }

  private settleTurnState(turnId: string, status: TuiSettledTurn['status']): void {
    this.updateState({
      status: 'idle',
      activeTurnId: undefined,
      cancelling: false,
      error: undefined,
      lastSettledTurn: createTuiSettledTurn(this.state.session?.sessionId, turnId, status),
    });
  }

  private failTurnState(message: string, retryable?: boolean, turnId?: string): void {
    this.updateState({
      status: 'error',
      activeTurnId: undefined,
      cancelling: false,
      error: message,
      errorRetryable: retryable,
      ...(turnId
        ? { lastSettledTurn: createTuiSettledTurn(this.state.session?.sessionId, turnId, 'failed') }
        : {}),
    });
  }

  private updateState(patch: Partial<TuiChatSnapshot>): void {
    const currentSessionId = this.state.session?.sessionId;
    const nextSessionId = 'session' in patch ? patch.session?.sessionId : currentSessionId;
    this.state = {
      ...this.state,
      ...patch,
      ...(currentSessionId !== nextSessionId && !('sessionUsage' in patch)
        ? { sessionUsage: undefined }
        : {}),
      ...(currentSessionId !== nextSessionId && !('sessionCost' in patch)
        ? { sessionCost: undefined }
        : {}),
      ...(currentSessionId !== nextSessionId && !('contextSnapshot' in patch)
        ? { contextSnapshot: undefined }
        : {}),
    };
    this.notify();
  }

  private notify(): void {
    if (this.notificationBatchDepth > 0) {
      this.notificationPending = true;
      return;
    }
    this.onChange?.(this.snapshot());
  }

  private batchNotifications<T>(operation: () => T): T {
    this.notificationBatchDepth += 1;
    try {
      return operation();
    } finally {
      this.notificationBatchDepth -= 1;
      if (this.notificationBatchDepth === 0 && this.notificationPending) {
        this.notificationPending = false;
        this.onChange?.(this.snapshot());
      }
    }
  }

  private resolveIdleWaiters(): void {
    if (this.activeTurn || this.runCoordinator.retiringTurnId()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function selectedModelLabel(
  model: { providerId?: string; modelId?: string; variant?: string } | undefined,
): string | undefined {
  if (!model?.modelId) return undefined;
  const base = model.providerId ? `${model.providerId}/${model.modelId}` : model.modelId;
  return model.variant && model.variant !== 'thinking' ? `${base}#${model.variant}` : base;
}

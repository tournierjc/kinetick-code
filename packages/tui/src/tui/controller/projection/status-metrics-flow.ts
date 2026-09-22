import { collectTuiDelegatedSessions } from '../../../runtime/delegation.js';
import {
  aggregateSessionCost,
  buildSessionCostRows,
  type SessionCostBreakdown,
  type SessionCostRow,
} from '../../../application/session-cost.js';
import type {
  TuiAccountStatus,
  TuiConfigurationPort,
  TuiInspectionPort,
  TuiSession,
  TuiSessionPort,
  TuiSessionUsageSummary,
  TuiContextSnapshotResponse,
} from '../../../runtime/port.js';

type StatusMetricsRuntime = Partial<Pick<TuiConfigurationPort, 'getAccountStatus'>> &
  Partial<
    Pick<
      TuiInspectionPort,
      | 'getSessionUsageSummary'
      | 'getSessionUsageWithRows'
      | 'getSessionTree'
      | 'getContextSnapshot'
    >
  > &
  Partial<Pick<TuiSessionPort, 'listSessions'>>;

export interface TuiStatusMetricsFlowOptions {
  readonly runtime: StatusMetricsRuntime;
  readonly currentSessionId: () => string | undefined;
  readonly currentAccount: () => TuiAccountStatus | undefined;
  /** Model label of the active Session; model-less usage rows fall back to it. */
  readonly currentModelLabel?: () => string | undefined;
  readonly apply: (patch: {
    account?: TuiAccountStatus;
    sessionUsage?: TuiSessionUsageSummary;
    sessionCost?: SessionCostBreakdown;
    contextSnapshot?: TuiContextSnapshotResponse;
  }) => void;
}

export class TuiStatusMetricsFlow {
  private accountRefreshSequence = 0;
  private usageRefreshSequence = 0;
  private contextRefreshSequence = 0;

  constructor(private readonly options: TuiStatusMetricsFlowOptions) {}

  async refresh(sessionId: string): Promise<void> {
    await Promise.all([
      this.refreshAccount(sessionId),
      this.refreshSessionUsage(sessionId),
      this.refreshContext(sessionId),
    ]);
  }

  async refreshSessionUsage(sessionId: string): Promise<void> {
    const summaryPromise = this.refreshSessionSummary(sessionId);
    const costPromise = this.refreshSessionCost(sessionId);
    await Promise.all([summaryPromise, costPromise]);
  }

  private async refreshSessionSummary(sessionId: string): Promise<void> {
    const getSessionUsageSummary = this.options.runtime.getSessionUsageSummary;
    if (!getSessionUsageSummary) return;
    const refreshSequence = ++this.usageRefreshSequence;
    const summary = await getSessionUsageSummary
      .call(this.options.runtime, sessionId)
      .catch(() => undefined);
    if (refreshSequence !== this.usageRefreshSequence) return;
    if (this.options.currentSessionId() !== sessionId) return;
    this.options.apply({ sessionUsage: summary });
  }

  /**
   * Refreshes the session-wide cost from the Session usage tree.
   *
   * The root Session is the `agent` scope; every delegated child Session
   * reachable from it (sub-agents, including nested delegations) is a
   * `subagent` scope. Each usage row carries the model that generated it, so
   * a mid-session model switch is aggregated per model and summed — never
   * attributed to whichever model happens to be selected now.
   */
  async refreshSessionCost(sessionId: string): Promise<void> {
    const getSessionUsageWithRows = this.options.runtime.getSessionUsageWithRows;
    if (!getSessionUsageWithRows) return;
    const refreshSequence = ++this.usageRefreshSequence;
    try {
      const subagentSessions = await this.collectSubagentSessions(sessionId);
      if (refreshSequence !== this.usageRefreshSequence) return;
      if (this.options.currentSessionId() !== sessionId) return;
      const rootModel = this.options.currentModelLabel?.();
      const [rootUsage, ...childUsages] = await Promise.all([
        getSessionUsageWithRows.call(this.options.runtime, sessionId),
        ...subagentSessions.map((session) =>
          getSessionUsageWithRows
            .call(this.options.runtime, session.sessionId)
            .catch(() => undefined),
        ),
      ]);
      if (refreshSequence !== this.usageRefreshSequence) return;
      if (this.options.currentSessionId() !== sessionId) return;
      const rows: SessionCostRow[] = [
        ...buildSessionCostRows(
          {
            scope: 'agent',
            model: rootModel ?? 'unknown',
            summary: rootUsage.summary ?? {},
            ...(rootUsage.rows ? { rows: rootUsage.rows } : {}),
          },
          rootModel,
        ),
      ];
      for (const [index, childUsage] of childUsages.entries()) {
        if (!childUsage) continue;
        const childModel = sessionModelLabel(subagentSessions[index]!.model) ?? rootModel;
        rows.push(
          ...buildSessionCostRows(
            {
              scope: 'subagent',
              model: childModel ?? 'unknown',
              summary: childUsage.summary ?? {},
              ...(childUsage.rows ? { rows: childUsage.rows } : {}),
            },
            childModel,
          ),
        );
      }
      if (refreshSequence !== this.usageRefreshSequence) return;
      if (this.options.currentSessionId() !== sessionId) return;
      this.options.apply({ sessionCost: aggregateSessionCost(rows) });
    } catch {
      // Cost stays silent rather than showing a stale or partial number.
    }
  }

  private async collectSubagentSessions(sessionId: string): Promise<TuiSession[]> {
    const getSessionTree = this.options.runtime.getSessionTree;
    if (getSessionTree) {
      const sessions = await getSessionTree.call(this.options.runtime).catch(() => undefined);
      if (sessions) return collectTuiDelegatedSessions(sessions, sessionId);
    }
    const listSessions = this.options.runtime.listSessions;
    if (!listSessions) return [];
    const sessions = await listSessions.call(this.options.runtime).catch(() => undefined);
    return sessions ? collectTuiDelegatedSessions(sessions, sessionId) : [];
  }

  async refreshContext(sessionId: string): Promise<void> {
    const getContextSnapshot = this.options.runtime.getContextSnapshot;
    if (!getContextSnapshot) return;
    const sequence = ++this.contextRefreshSequence;
    const contextSnapshot = await Promise.resolve()
      .then(() => getContextSnapshot.call(this.options.runtime, sessionId))
      .catch(() => undefined);
    if (sequence !== this.contextRefreshSequence || this.options.currentSessionId() !== sessionId)
      return;
    this.options.apply({ contextSnapshot });
  }

  async refreshAccount(sessionId?: string): Promise<void> {
    const getAccountStatus = this.options.runtime.getAccountStatus;
    if (!getAccountStatus) return;
    const refreshSequence = ++this.accountRefreshSequence;
    await Promise.resolve()
      .then(() =>
        getAccountStatus.call(this.options.runtime, sessionId, { includeMembership: false }),
      )
      .then(
        (account) => {
          if (!account || refreshSequence !== this.accountRefreshSequence) return;
          if (sessionId && this.options.currentSessionId() !== sessionId) return;
          this.options.apply({ account });

          if (account.modelSource === 'token-plan' && account.managedTokenPresent === true) {
            void this.refreshMembership(sessionId, refreshSequence);
          }
        },
        () => {
          if (refreshSequence !== this.accountRefreshSequence || this.options.currentAccount())
            return;
          if (sessionId && this.options.currentSessionId() !== sessionId) return;
          this.options.apply({ account: { status: 'unknown', warnings: [] } });
        },
      );
  }

  private async refreshMembership(sessionId: string | undefined, refreshSequence: number) {
    const getAccountStatus = this.options.runtime.getAccountStatus;
    if (!getAccountStatus) return;
    const account = await getAccountStatus
      .call(this.options.runtime, sessionId, { includeMembership: true })
      .catch(() => undefined);
    if (!account || refreshSequence !== this.accountRefreshSequence) return;
    if (sessionId && this.options.currentSessionId() !== sessionId) return;
    this.options.apply({ account });
  }

  refreshCurrent(): void {
    const sessionId = this.options.currentSessionId();
    if (!sessionId) {
      void this.refreshAccount();
      return;
    }
    void this.refresh(sessionId);
  }
}

function sessionModelLabel(
  model: { providerId?: string; modelId?: string } | undefined,
): string | undefined {
  if (!model) return undefined;
  if (!model.modelId) return undefined;
  return model.providerId ? `${model.providerId}/${model.modelId}` : model.modelId;
}

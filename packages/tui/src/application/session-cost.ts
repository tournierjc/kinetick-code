/**
 * Session cost accounting.
 *
 * The Runtime records one usage row per assistant message with the model that
 * produced it (`provider/model`) and the USD cost the provider reported for
 * that message. A Session can switch models mid-run and can delegate to
 * sub-agent Sessions, so the aggregate is computed per model and summed, and
 * the Session-tree view folds every delegated child Session into the total.
 *
 * Rows without a provider-reported cost (local or free endpoints, custom
 * providers with an unpriced catalog entry) contribute $0 — the same
 * "unknown prices are zero" policy the Runtime's `calculateCost` applies —
 * and are counted in `unpricedRows` so the detail view can stay honest about
 * what the total actually covers.
 */

import type { TuiSessionUsageRow, TuiSessionUsageSummary } from '../runtime/port.js';

export interface SessionCostModelBreakdown {
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cacheReadRatio: number;
  readonly turns: number;
  readonly unpricedRows: number;
  /** Which scopes contributed to this model's rows. */
  readonly scopes: ReadonlySet<'agent' | 'subagent'>;
}

export interface SessionCostSplit {
  readonly agent: SessionCostModelBreakdown;
  readonly subagent: SessionCostModelBreakdown;
}

export interface SessionCostBreakdown {
  /** Root Session only — matches the token rows `/usage` already reports. */
  readonly root: SessionCostModelBreakdown;
  /** Root plus every delegated (sub-agent) Session in the tree. */
  readonly total: SessionCostModelBreakdown;
  readonly models: readonly SessionCostModelBreakdown[];
  readonly split: SessionCostSplit;
  /** True when any folded-in row lacked a provider-reported cost. */
  readonly hasUnpricedRows: boolean;
}

export interface SessionCostModelRow {
  readonly scope: 'agent' | 'subagent';
  readonly model: string;
  readonly summary: TuiSessionUsageSummary;
  readonly rows?: readonly TuiSessionUsageRow[];
}

/** One usage row from a named scope, tagged with its cost-bearing model. */
export interface SessionCostRow {
  readonly scope: 'agent' | 'subagent';
  readonly model: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Projects one Session's usage rows into scoped, model-tagged cost rows.
 *
 * The Runtime writes the generating model onto every usage row, so rows carry
 * the per-model split and mid-session model switches stay honest. Rows
 * without a model (older Runtime data) fall back to the caller-provided
 * default model. `scope` decides the agent/sub-agent bucket: the root Session
 * is `agent`, every delegated Session is `subagent`.
 */
export function buildSessionCostRows(
  input: SessionCostModelRow,
  defaultModel: string | undefined,
): readonly SessionCostRow[] {
  const rows = input.rows ?? [];
  if (rows.length === 0) {
    // No row detail (older Runtime or summary-only port): one aggregate row.
    const summary = input.summary;
    if (summary.turns !== undefined && summary.turns <= 0) return [];
    const model = input.model ?? defaultModel ?? 'unknown';
    return [
      {
        scope: input.scope,
        model,
        costUsd:
          typeof summary.costUsd === 'number' && Number.isFinite(summary.costUsd)
            ? summary.costUsd
            : null,
        inputTokens: count(summary.inputTokens),
        outputTokens: count(summary.outputTokens),
        cacheReadTokens: count(summary.cacheReadTokens),
        cacheWriteTokens: count(summary.cacheWriteTokens),
      },
    ];
  }
  return rows.map((row) => {
    const fallbackModel = row.agentName?.trim() ? input.model : defaultModel;
    return {
      scope: input.scope,
      model: row.model?.trim() || fallbackModel?.trim() || 'unknown',
      costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : null,
      inputTokens: count(row.inputTokens),
      outputTokens: count(row.outputTokens),
      cacheReadTokens: count(row.cacheReadTokens),
      cacheWriteTokens: count(row.cacheWriteTokens),
    };
  });
}

/** Aggregates cost rows per model, then folds scopes into the session total. */
export function aggregateSessionCost(
  rows: readonly SessionCostRow[],
): SessionCostBreakdown | undefined {
  if (rows.length === 0) return undefined;
  const root = fold(rows.filter((row) => row.scope === 'agent'));
  const subagent = fold(rows.filter((row) => row.scope === 'subagent'));
  const total = merge(root, subagent);
  // Keep the model table ordered by cost, then name, so the expensive model
  // always reads first regardless of turn order.
  const models = mergeBreakdowns(rows);
  return {
    root,
    total,
    models,
    split: { agent: root, subagent },
    hasUnpricedRows: rows.some((row) => row.costUsd === null),
  };
}

/** Formats a cost as `$0.0042` (2 decimals from $1, 4 below). */
export function formatTuiCostUsd(value: number): string {
  const rounded = value >= 1 ? value.toFixed(2) : value.toFixed(4);
  return `$${rounded}`;
}

function fold(rows: readonly SessionCostRow[]): SessionCostModelBreakdown {
  const inputTokens = sum(rows, (row) => row.inputTokens);
  const outputTokens = sum(rows, (row) => row.outputTokens);
  const cacheReadTokens = sum(rows, (row) => row.cacheReadTokens);
  const cacheWriteTokens = sum(rows, (row) => row.cacheWriteTokens);
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    model: 'all models',
    costUsd: sum(rows, (row) => row.costUsd ?? 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cacheReadRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
    turns: rows.length,
    unpricedRows: rows.filter((row) => row.costUsd === null).length,
    scopes: scopesOf(rows),
  };
}

function merge(
  left: SessionCostModelBreakdown,
  right: SessionCostModelBreakdown,
): SessionCostModelBreakdown {
  const costUsd = left.costUsd + right.costUsd;
  const inputTokens = left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
  const cacheReadTokens = left.cacheReadTokens + right.cacheReadTokens;
  const cacheWriteTokens = left.cacheWriteTokens + right.cacheWriteTokens;
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    model: 'all models',
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cacheReadRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
    turns: left.turns + right.turns,
    unpricedRows: left.unpricedRows + right.unpricedRows,
    scopes: unionScopes(left.scopes, right.scopes),
  };
}

function mergeBreakdowns(rows: readonly SessionCostRow[]): readonly SessionCostModelBreakdown[] {
  const byModel = new Map<string, SessionCostRow[]>();
  for (const row of rows) {
    const bucket = byModel.get(row.model);
    if (bucket) bucket.push(row);
    else byModel.set(row.model, [row]);
  }
  return [...byModel.entries()]
    .map(([model, modelRows]) => ({ ...fold(modelRows), model }))
    .sort(
      (left, right) =>
        right.costUsd - left.costUsd ||
        left.model.localeCompare(right.model) ||
        right.totalTokens - left.totalTokens,
    );
}

function scopesOf(rows: readonly SessionCostRow[]): Set<'agent' | 'subagent'> {
  const scopes = new Set<'agent' | 'subagent'>();
  for (const row of rows) scopes.add(row.scope);
  return scopes;
}

function unionScopes(
  left: ReadonlySet<'agent' | 'subagent'>,
  right: ReadonlySet<'agent' | 'subagent'>,
): Set<'agent' | 'subagent'> {
  const scopes = new Set<'agent' | 'subagent'>(left);
  for (const scope of right) scopes.add(scope);
  return scopes;
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  let total = 0;
  for (const value of values) total += read(value);
  return total;
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

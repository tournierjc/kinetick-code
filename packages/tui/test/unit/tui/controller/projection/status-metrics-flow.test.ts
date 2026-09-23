import { describe, expect, it, vi } from 'vitest';

import { TuiStatusMetricsFlow } from '../../../../../src/tui/controller/projection/status-metrics-flow.js';
import type { SessionCostBreakdown } from '../../../../../src/application/session-cost.js';

const rootSession = { sessionId: 'root', sessionType: 'root' as const };
const subagentSession = {
  sessionId: 'child-1',
  sessionType: 'branch' as const,
  parentSessionId: 'root',
  sessionKind: 'task',
  model: { providerId: 'custom', modelId: 'qwen' },
};

function runtimeFixture(overrides: Record<string, unknown> = {}) {
  return {
    getSessionUsageSummary: vi.fn(async () => ({ inputTokens: 1, costUsd: 0.001 })),
    getSessionUsageWithRows: vi.fn(async (sessionId: string) =>
      sessionId === 'root'
        ? {
            summary: { inputTokens: 100, outputTokens: 20, costUsd: 0.002 },
            rows: [
              { model: 'openrouter/z-ai/glm-5.3-flash', inputTokens: 60, outputTokens: 10, costUsd: 0.001 },
              { model: 'openrouter/moonshotai/kimi-k3', inputTokens: 40, outputTokens: 10, costUsd: 0.001 },
            ],
          }
        : {
            summary: { inputTokens: 50, outputTokens: 5, costUsd: null },
            rows: [{ inputTokens: 50, outputTokens: 5 }],
          },
    ),
    getSessionTree: vi.fn(async () => [rootSession, subagentSession]),
    ...overrides,
  };
}

function buildFlow(runtime: ReturnType<typeof runtimeFixture>) {
  const patches: Array<Record<string, unknown>> = [];
  const flow = new TuiStatusMetricsFlow({
    runtime: runtime as never,
    currentSessionId: () => 'root',
    currentAccount: () => undefined,
    currentModelLabel: () => 'openrouter/z-ai/glm-5.3-flash',
    apply: (patch) => patches.push(patch),
  });
  return { flow, patches };
}

describe('TuiStatusMetricsFlow session cost', () => {
  it('aggregates the root Session and delegated child usage per model', async () => {
    const runtime = runtimeFixture();
    const { flow, patches } = buildFlow(runtime);

    await flow.refreshSessionCost('root');

    const costPatch = patches
      .map((patch) => patch.sessionCost as SessionCostBreakdown | undefined)
      .find((value) => value !== undefined);
    expect(costPatch).toBeDefined();
    // Root rows carry their own models; the child row has no model and falls
    // back to the child Session's model (custom/qwen).
    expect(costPatch!.models.map((model) => model.model).sort()).toEqual([
      'custom/qwen',
      'openrouter/moonshotai/kimi-k3',
      'openrouter/z-ai/glm-5.3-flash',
    ]);
    expect(costPatch!.split.agent.costUsd).toBeCloseTo(0.002, 10);
    expect(costPatch!.total.costUsd).toBeCloseTo(0.002, 10);
    expect(costPatch!.hasUnpricedRows).toBe(true);
    expect(runtime.getSessionUsageWithRows).toHaveBeenCalledWith('root');
    expect(runtime.getSessionUsageWithRows).toHaveBeenCalledWith('child-1');
  });

  it('drops the result when the visible Session changed mid-refresh', async () => {
    const runtime = runtimeFixture();
    const apply = vi.fn();
    const flow = new TuiStatusMetricsFlow({
      runtime: runtime as never,
      currentSessionId: () => 'other-session',
      currentAccount: () => undefined,
      apply,
    });

    await flow.refreshSessionCost('root');

    expect(apply).not.toHaveBeenCalled();
  });

  it('stays silent when the cost API is unavailable', async () => {
    const runtime = runtimeFixture({ getSessionUsageWithRows: undefined });
    const apply = vi.fn();
    const flow = new TuiStatusMetricsFlow({
      runtime: runtime as never,
      currentSessionId: () => 'root',
      currentAccount: () => undefined,
      apply,
    });

    await flow.refreshSessionCost('root');

    expect(apply).not.toHaveBeenCalled();
  });

  it('falls back to listSessions when the tree API is unavailable', async () => {
    const runtime = runtimeFixture({
      getSessionTree: undefined,
      listSessions: vi.fn(async () => [rootSession, subagentSession]),
    });
    const { flow, patches } = buildFlow(runtime);

    await flow.refreshSessionCost('root');

    const costPatch = patches
      .map((patch) => patch.sessionCost as SessionCostBreakdown | undefined)
      .find((value) => value !== undefined);
    expect(costPatch!.split.subagent.turns).toBe(1);
  });
});

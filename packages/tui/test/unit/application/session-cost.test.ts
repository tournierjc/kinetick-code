import { describe, expect, it } from 'vitest';

import {
  aggregateSessionCost,
  buildSessionCostRows,
  formatTuiCostUsd,
} from '../../../src/application/session-cost.js';

const rootSummary = { inputTokens: 100, outputTokens: 50, costUsd: 0.002 };

describe('buildSessionCostRows', () => {
  it('tags row-level usage with the model that generated each row', () => {
    const rows = buildSessionCostRows(
      {
        scope: 'agent',
        model: 'openrouter/z-ai/glm-5.3-flash',
        summary: { inputTokens: 30, outputTokens: 10, costUsd: 0.003 },
        rows: [
          { model: 'openrouter/z-ai/glm-5.3-flash', inputTokens: 20, outputTokens: 5, costUsd: 0.002 },
          { model: 'openrouter/moonshotai/kimi-k3', inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        ],
      },
      'openrouter/z-ai/glm-5.3-flash',
    );

    expect(rows.map((row) => row.model)).toEqual([
      'openrouter/z-ai/glm-5.3-flash',
      'openrouter/moonshotai/kimi-k3',
    ]);
    expect(rows[1]?.costUsd).toBe(0.001);
  });

  it('falls back to the caller model for rows without a model', () => {
    const rows = buildSessionCostRows(
      { scope: 'agent', model: 'custom/qwen', summary: rootSummary, rows: [{ inputTokens: 5 }] },
      'custom/qwen',
    );

    expect(rows[0]?.model).toBe('custom/qwen');
  });

  it('projects an unpriced row as a null cost, not zero', () => {
    const rows = buildSessionCostRows(
      { scope: 'agent', model: 'custom/qwen', summary: rootSummary, rows: [{ inputTokens: 5 }] },
      'custom/qwen',
    );

    expect(rows[0]?.costUsd).toBeNull();
  });

  it('falls back to the summary when no rows exist', () => {
    const rows = buildSessionCostRows(
      { scope: 'subagent', model: 'custom/qwen', summary: { inputTokens: 7, costUsd: 0.01 } },
      'custom/qwen',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'subagent', costUsd: 0.01, inputTokens: 7 });
  });

  it('skips a summary that recorded zero turns', () => {
    expect(
      buildSessionCostRows({ scope: 'subagent', model: 'm', summary: { turns: 0 } }, 'm'),
    ).toEqual([]);
  });
});

describe('aggregateSessionCost', () => {
  it('aggregates per model and sums the model totals', () => {
    const breakdown = aggregateSessionCost([
      { scope: 'agent', model: 'a', costUsd: 0.001, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { scope: 'agent', model: 'b', costUsd: 0.004, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { scope: 'subagent', model: 'a', costUsd: 0.002, inputTokens: 8, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);

    expect(breakdown?.total.costUsd).toBeCloseTo(0.007, 10);
    expect(breakdown?.models.map((model) => model.model)).toEqual(['b', 'a']);
    expect(breakdown?.models[1]?.costUsd).toBeCloseTo(0.003, 10);
    expect(breakdown?.models[1]?.scopes.has('subagent')).toBe(true);
  });

  it('splits agent from sub-agent scopes', () => {
    const breakdown = aggregateSessionCost([
      { scope: 'agent', model: 'a', costUsd: 0.002, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { scope: 'subagent', model: 'a', costUsd: 0.005, inputTokens: 1, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0 },
    ]);

    expect(breakdown?.split.agent.costUsd).toBeCloseTo(0.002, 10);
    expect(breakdown?.split.subagent.costUsd).toBeCloseTo(0.005, 10);
    expect(breakdown?.total.costUsd).toBeCloseTo(0.007, 10);
    expect(breakdown?.total.cacheReadRatio).toBeGreaterThan(0.9);
  });

  it('counts unpriced rows and keeps them at zero cost', () => {
    const breakdown = aggregateSessionCost([
      { scope: 'agent', model: 'local', costUsd: null, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { scope: 'agent', model: 'priced', costUsd: 0.01, inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);

    expect(breakdown?.total.costUsd).toBeCloseTo(0.01, 10);
    expect(breakdown?.hasUnpricedRows).toBe(true);
    expect(breakdown?.models.find((model) => model.model === 'local')?.unpricedRows).toBe(1);
  });

  it('returns undefined without rows', () => {
    expect(aggregateSessionCost([])).toBeUndefined();
  });
});

describe('formatTuiCostUsd', () => {
  it('uses four decimals below one dollar and two from one dollar up', () => {
    expect(formatTuiCostUsd(0)).toBe('$0.0000');
    expect(formatTuiCostUsd(0.42)).toBe('$0.4200');
    expect(formatTuiCostUsd(1)).toBe('$1.00');
    expect(formatTuiCostUsd(12.3456)).toBe('$12.35');
  });
});

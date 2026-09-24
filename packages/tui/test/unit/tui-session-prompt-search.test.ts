import { describe, expect, it } from 'vitest';

import {
  SESSION_PROMPT_SEARCH_CONCURRENCY,
  SESSION_PROMPT_SEARCH_LIMIT,
  searchSessionPrompts,
  tokenizeSessionPromptQuery,
  type TuiSessionPromptSearchPort,
} from '../../src/tui/features/session/prompt-search.js';
import type { TuiSessionInputSummary } from '../../src/runtime/port.js';

function summary(contentHead: string): TuiSessionInputSummary {
  return {
    userMessageId: `user-${contentHead.slice(0, 8)}`,
    assistantMessageId: `assistant-${contentHead.slice(0, 8)}`,
    contentHead,
    timestamp: 1_700_000_000_000,
    fileChangeCount: 0,
  };
}

function portOf(
  summaries: Record<string, readonly TuiSessionInputSummary[]>,
): TuiSessionPromptSearchPort & { calls: Array<{ sessionId: string; limit?: number }> } {
  const calls: Array<{ sessionId: string; limit?: number }> = [];
  return {
    calls,
    listSessionInputSummaries: async (sessionId, input) => {
      calls.push({ sessionId, ...(input?.limit === undefined ? {} : { limit: input.limit }) });
      const found = summaries[sessionId];
      if (!found) throw new Error('history unavailable');
      return found;
    },
  };
}

describe('tokenizeSessionPromptQuery', () => {
  it('lowercases and splits on whitespace like the catalog filter', () => {
    expect(tokenizeSessionPromptQuery('  Fix   The LOGIN  ')).toEqual(['fix', 'the', 'login']);
    expect(tokenizeSessionPromptQuery('   ')).toEqual([]);
  });
});

describe('searchSessionPrompts', () => {
  it('matches every token against a saved prompt and quotes it back', async () => {
    const port = portOf({
      'session-1': [summary('Refactor the runtime loader')],
      'session-2': [summary('Fix the login flow'), summary('Add login tests')],
    });

    const matches = await searchSessionPrompts(port, 'login', ['session-1', 'session-2']);

    expect(matches).toEqual([{ sessionId: 'session-2', snippet: 'Fix the login flow' }]);
  });

  it('reports the first matching prompt of a Session once', async () => {
    const port = portOf({
      'session-1': [
        summary('Unrelated work'),
        summary('Tune the retry budget'),
        summary('Tune the retry backoff'),
      ],
    });

    const matches = await searchSessionPrompts(port, 'tune retry', ['session-1']);

    expect(matches).toEqual([{ sessionId: 'session-1', snippet: 'Tune the retry budget' }]);
  });

  it('reads a bounded number of prompts per Session', async () => {
    const port = portOf({ 'session-1': [summary('anything')] });

    await searchSessionPrompts(port, 'anything', ['session-1']);

    expect(port.calls).toEqual([{ sessionId: 'session-1', limit: SESSION_PROMPT_SEARCH_LIMIT }]);
  });

  it('skips an unreadable Session instead of failing the search', async () => {
    const port = portOf({ 'session-2': [summary('Fix the login flow')] });

    const matches = await searchSessionPrompts(port, 'login', ['session-1', 'session-2']);

    expect(matches).toEqual([{ sessionId: 'session-2', snippet: 'Fix the login flow' }]);
  });

  it('keeps the number of concurrent reads bounded', async () => {
    let inFlight = 0;
    let peak = 0;
    const port: TuiSessionPromptSearchPort = {
      listSessionInputSummaries: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return [summary('nothing here')];
      },
    };
    const sessionIds = Array.from({ length: 32 }, (_, index) => `session-${String(index)}`);

    const matches = await searchSessionPrompts(port, 'missing', sessionIds);

    expect(matches).toEqual([]);
    expect(peak).toBeLessThanOrEqual(SESSION_PROMPT_SEARCH_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('does nothing without a query, a port or Sessions', async () => {
    const port = portOf({ 'session-1': [summary('Fix the login flow')] });

    expect(await searchSessionPrompts(port, '   ', ['session-1'])).toEqual([]);
    expect(await searchSessionPrompts(undefined, 'login', ['session-1'])).toEqual([]);
    expect(await searchSessionPrompts(port, 'login', [])).toEqual([]);
    expect(port.calls).toEqual([]);
  });
});

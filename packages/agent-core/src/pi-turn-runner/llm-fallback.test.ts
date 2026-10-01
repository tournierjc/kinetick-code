import { describe, expect, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';

import {
  resolveFallbackChain,
  normalizeModelChain,
  withLLMFallback,
  type LLMFallbackCandidate,
  type LLMFallbackEvent,
} from './llm-fallback.js';

function modelFor(id: string, provider = 'test-provider', baseUrl?: string): Model<never> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: baseUrl ?? `https://${provider}.invalid`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1000,
  } as unknown as Model<never>;
}

function assistantMessage(
  overrides: Partial<AssistantMessage> & { content: AssistantMessage['content'] },
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'test-provider',
    model: 'x',
    stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    timestamp: Date.now(),
    ...overrides,
  } as unknown as AssistantMessage;
}

function streamFrom(events: (() => void)[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const emit of events) emit();
  });
  return stream;
}

function makeStream(
  emitter: (stream: AssistantMessageEventStream) => void,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => emitter(stream));
  return stream;
}

function failingStreamFn(message: string): StreamFn {
  return (async () =>
    makeStream((stream) => {
      const final = assistantMessage({
        content: [],
        stopReason: 'error',
        errorMessage: message,
      });
      stream.push({ type: 'error', reason: 'error', error: final });
      stream.end(final);
    })) as StreamFn;
}

function committingStreamFn(text: string): StreamFn {
  return (async () =>
    makeStream((stream) => {
      const content = [{ type: 'text', text }] as AssistantMessage['content'];
      const final = assistantMessage({ content });
      stream.push({ type: 'text_start', contentIndex: 0, partial: final });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: final });
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: final });
      stream.push({ type: 'done', reason: 'stop', message: final });
      stream.end(final);
    })) as StreamFn;
}

function candidate(modelKey: string, streamFn: StreamFn): LLMFallbackCandidate {
  const [provider, id] = modelKey.split('/');
  return { modelKey, route: { model: modelFor(id, provider), streamFn } };
}

async function consumeText(stream: AssistantMessageEventStream): Promise<string> {
  for await (const _event of stream) {
    // Drain so the provider-side microtasks settle.
  }
  const final = await stream.result();
  return (final.content ?? [])
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

const FAST_SLEEP = async () => {};

describe('normalizeModelChain', () => {
  it('keeps provider/model entries, drops duplicates and malformed keys, caps at limit', () => {
    expect(
      normalizeModelChain(['a/b', 'a/b', 'bad', '/x', 'y/', ' c/d ', 'e/f', 'g/h'], 2),
    ).toEqual(['a/b', 'c/d']);
  });
  it('returns undefined for empty input', () => {
    expect(normalizeModelChain([])).toBeUndefined();
    expect(normalizeModelChain(undefined)).toBeUndefined();
  });
});

describe('resolveFallbackChain', () => {
  it('drops unresolvable entries and preserves declared order', async () => {
    const routes = await resolveFallbackChain(
      ['a/one', 'b/two', 'c/three'],
      async (key) =>
        key === 'b/two' ? undefined : { model: modelFor('m'), streamFn: committingStreamFn('ok') },
    );
    expect(routes.map((route) => route.modelKey)).toEqual(['a/one', 'c/three']);
  });
  it('drops entries whose resolution throws', async () => {
    const routes = await resolveFallbackChain(['a/one', 'b/two'], async (key) => {
      if (key === 'a/one') throw new Error('missing key');
      return { model: modelFor('m'), streamFn: committingStreamFn('ok') };
    });
    expect(routes.map((route) => route.modelKey)).toEqual(['b/two']);
  });
});

describe('withLLMFallback', () => {
  it('single-entry chain delegates to plain retry behavior', async () => {
    const inner = committingStreamFn('hello');
    const streamFn = withLLMFallback(inner, {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [candidate('primary/m1', inner)],
      sleep: FAST_SLEEP,
    });
    const text = await consumeText(
      await streamFn(modelFor('m1'), { messages: [] } as never, undefined),
    );
    expect(text).toBe('hello');
  });

  it('promotes to the next candidate when the primary fails before any output', async () => {
    const events: LLMFallbackEvent[] = [];
    const streamFn = withLLMFallback(failingStreamFn('primary down'), {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [
        candidate('primary/m1', failingStreamFn('primary down')),
        candidate('backup/m2', committingStreamFn('from backup')),
      ],
      sleep: FAST_SLEEP,
      observer: (event) => {
        events.push(event);
      },
    });
    const text = await consumeText(
      await streamFn(modelFor('m1'), { messages: [] } as never, undefined),
    );
    expect(text).toBe('from backup');
    expect(events.some((event) => event.status === 'activated' && event.toModel === 'backup/m2')).toBe(
      true,
    );
  });

  it('exhausts the chain and reports an exhausted event', async () => {
    const events: LLMFallbackEvent[] = [];
    const streamFn = withLLMFallback(failingStreamFn('all down'), {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [
        candidate('primary/m1', failingStreamFn('down 1')),
        candidate('backup/m2', failingStreamFn('down 2')),
      ],
      sleep: FAST_SLEEP,
      observer: (event) => {
        events.push(event);
      },
    });
    const stream = await streamFn(modelFor('m1'), { messages: [] } as never, undefined);
    await expect(stream.result()).rejects.toThrow(/chain exhausted/i);
    expect(events.some((event) => event.status === 'exhausted')).toBe(true);
  });

  it('skips a candidate that shares the primary backend identity', async () => {
    const streamFn = withLLMFallback(failingStreamFn('down'), {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [
        candidate('primary/m1', failingStreamFn('down')),
        {
          // Same provider|id|baseUrl triple as the primary's model.
          modelKey: 'primary/dup',
          route: {
            model: modelFor('m1', 'primary', 'https://primary.invalid'),
            streamFn: committingStreamFn('never'),
          },
        },
      ],
      sleep: FAST_SLEEP,
    });
    const stream = await streamFn(
      modelFor('m1', 'primary', 'https://primary.invalid'),
      { messages: [] } as never,
      undefined,
    );
    await expect(stream.result()).rejects.toThrow(/chain exhausted/i);
  });

  it('never fails over after the stream committed output', async () => {
    const committingThenFailing: StreamFn = (async () =>
      makeStream((stream) => {
        const partial = assistantMessage({
          content: [{ type: 'text', text: 'partial ' }],
          stopReason: 'stop',
        });
        stream.push({ type: 'text_start', contentIndex: 0, partial });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial ', partial });
        stream.push({ type: 'text_end', contentIndex: 0, content: 'partial ', partial });
        const final = assistantMessage({
          content: [{ type: 'text', text: 'partial ' }],
          stopReason: 'error',
          errorMessage: 'mid-stream break',
        });
        stream.push({ type: 'error', reason: 'error', error: final });
        stream.end(final);
      })) as StreamFn;
    const streamFn = withLLMFallback(committingThenFailing, {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [
        candidate('primary/m1', committingThenFailing),
        candidate('backup/m2', committingStreamFn('SHOULD NOT APPEAR')),
      ],
      sleep: FAST_SLEEP,
    });
    const stream = await streamFn(modelFor('m1'), { messages: [] } as never, undefined);
    const final = await stream.result();
    expect(final.stopReason).toBe('error');
    const text = (final.content ?? [])
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    expect(text).toBe('partial ');
  });

  it('cooldowns a failed candidate: the next call skips it (Hermes reset-window behavior)', async () => {
    let clock = 1_000_000;
    const events: LLMFallbackEvent[] = [];
    const streamFn = withLLMFallback(failingStreamFn('primary down'), {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [
        candidate('primary/m1', failingStreamFn('primary down')),
        candidate('backup/m2', failingStreamFn('backup down')),
      ],
      sleep: FAST_SLEEP,
      nowMs: () => clock,
      observer: (event) => {
        events.push(event);
      },
    });
    const first = await streamFn(modelFor('m1'), { messages: [] } as never, undefined);
    await expect(first.result()).rejects.toThrow(/chain exhausted/i);
    const firstRunEvents = [...events];
    events.length = 0;
    // Immediate second call: the backup is inside its cooldown window.
    clock += 1_000;
    const second = await streamFn(modelFor('m1'), { messages: [] } as never, undefined);
    await expect(second.result()).rejects.toThrow(/chain exhausted/i);
    expect(events.some((event) => event.status === 'cooldown' && event.toModel === 'backup/m2')).toBe(
      true,
    );
    expect(firstRunEvents.some((event) => event.status === 'activated')).toBe(true);
  });

  it('never promotes on an aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    const streamFn = withLLMFallback(failingStreamFn('down'), {
      sessionId: 's',
      turnId: 't',
      scope: 'agent',
      chain: [
        candidate('primary/m1', failingStreamFn('down')),
        candidate('backup/m2', committingStreamFn('late')),
      ],
      sleep: FAST_SLEEP,
    });
    // An aborted call surfaces as a throwing (or aborted-result) stream;
    // the decisive invariant is that the backup never runs.
    const outcome = await Promise.resolve(
      streamFn(modelFor('m1'), { messages: [] } as never, {
        signal: controller.signal,
      }),
    )
      .then(async (stream) => stream.result().catch((error: unknown) => ({ thrown: error })))
      .catch((error: unknown) => ({ thrown: error }));
    expect(outcome).toBeDefined();
    const text =
      typeof outcome === 'object' && outcome !== null && 'content' in outcome
        ? (outcome as { content: { type: string; text?: string }[] })
            .content.filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
        : '';
    expect(text).not.toBe('late');
  });
});

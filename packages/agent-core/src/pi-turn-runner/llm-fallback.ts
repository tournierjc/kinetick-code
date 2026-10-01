// Per-agent model fallback chain, transposed from Hermes Agent's runtime
// fallback mechanism (`agent_init._init_fallback_chain`,
// `_should_skip_fallback_candidate`, `fallback_cooldown`,
// `auxiliary_fallback_recovery`). The invariants that make Hermes' failover
// safe are preserved one-for-one:
//
// - Chain order is `[primary, ...fallbacks]`: an exhausted primary promotes
//   the next candidate and the FULL retry policy runs for it (Hermes advances
//   the fallback chain only after the current entry is exhausted, and runs
//   the normal retry loop per entry).
// - Backend identity, not model id, gates candidate reuse: provider + model +
//   resolved baseUrl must all differ from the last-failed identity (Hermes'
//   BackendIdentity skip), so a flapping endpoint cannot be re-entered every
//   call.
// - Rate-limit cooldowns honour the provider reset time: a candidate that
//   failed with rate limiting is skipped until its reset window closes
//   (Hermes' `_rate_limited_until` / `switch_deferred_by_reset`); a candidate
//   whose cooldown elapsed is re-probed (Hermes' `restore_primary_runtime`
//   recovery), so recovery is automatic, never sticky.
// - A committed (output-producing) stream never fails over — there is no
//   rewinding what the user already saw. The promotion decision happens in
//   the pre-output window: the wrapper buffers events until the provider
//   commits output, exactly like the preflight inside `withLLMRetry`.

import { normalizeLLMError, toLLMRetryDecision } from '@mavis/shared/llm-error-classifier';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ProviderResponse,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';

import {
  LLM_RETRY_CALL_IDENTITY,
  withLLMRetry,
  type LLMRetryOptions,
  type LLMRetryPolicy,
} from './llm-retry.js';

/** One chain member as declared by the host: `provider/model` + its route parameters. */
export interface LLMFallbackModelRef {
  /** Source-qualified model key, e.g. `minimax/MiniMax-M2.5` or `custom_provider:ollama/llama3`. */
  readonly model: string;
  readonly variant?: string;
  readonly effort?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

/** A chain member the host resolved into a concrete route (model + endpoint + credential). */
export interface LLMResolvedFallbackRoute {
  readonly model: Parameters<StreamFn>[0];
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  /** Fully-composed StreamFn for this route (host owns credential/timeout wiring). */
  readonly streamFn: StreamFn;
}

export interface LLMFallbackCandidate {
  readonly modelKey: string;
  readonly route: LLMResolvedFallbackRoute;
}

export type LLMFallbackStatus = 'activated' | 'cooldown' | 'exhausted';

export interface LLMFallbackEvent {
  sessionId: string;
  turnId: string;
  scope: LLMRetryOptions['scope'];
  status: LLMFallbackStatus;
  /** Chain index of the candidate the promotion targets (0 is the primary). */
  candidateIndex: number;
  /** Model key the call ran on when the event was recorded. */
  fromModel: string;
  /** Model key the call moves to; absent for `exhausted`. */
  toModel?: string;
  /** Normalized failure reason that triggered the promotion/cooldown. */
  reason?: string;
  /** Wall-clock ms until the failed candidate's cooldown ends (Hermes reset time). */
  cooldownUntilMs?: number;
}

export interface LLMFallbackPolicy {
  /** Consecutive-call cooldown applied after a non-rate-limit failover. Default 60s. */
  cooldownMs: number;
  /** Upper bound applied to a provider-provided reset window. Default 15min. */
  maxCooldownMs: number;
}

export const DEFAULT_LLM_FALLBACK_POLICY: Readonly<LLMFallbackPolicy> = {
  cooldownMs: 60_000,
  maxCooldownMs: 15 * 60_000,
} as const;

export interface LLMFallbackOptions {
  sessionId: string;
  turnId: string;
  scope: LLMRetryOptions['scope'];
  /** Chain order: `[primary, ...fallbacks]`. One entry behaves exactly like a plain retry stream. */
  chain: readonly LLMFallbackCandidate[];
  /** Per-candidate retry policy (the wrapper runs it for every candidate). */
  policy?: Partial<LLMRetryPolicy>;
  fallbackPolicy?: Partial<LLMFallbackPolicy>;
  observer?: (event: LLMFallbackEvent) => void | Promise<void>;
  nowMs?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface CandidateHealth {
  /** Wall-clock (ms) until which this candidate is skipped. */
  cooldownUntilMs?: number;
  /** `${provider}|${modelId}|${baseUrl}` identity captured at last failure. */
  lastFailureIdentity?: string;
}

/** Backend identity used for the same-backend skip (Hermes' providerId+modelId+base_url triple). */
function backendIdentityOf(model: Parameters<StreamFn>[0]): string {
  return `${String(model?.provider)}|${String(model?.id)}|${String(model?.baseUrl ?? '')}`;
}

function isAbort(thrown: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  try {
    return normalizeLLMError({ raw: thrown }).facts.explicitAbort === true;
  } catch {
    return false;
  }
}

function classifyFailure(thrown: unknown): { reason: string; rateLimited: boolean } {
  try {
    const normalized = normalizeLLMError({ raw: thrown });
    const decision = toLLMRetryDecision(normalized);
    const reason: string = decision.reason;
    return {
      reason,
      rateLimited: reason === 'rate_limited' || reason === 'tpm_rate_limited',
    };
  } catch {
    return { reason: 'unknown', rateLimited: false };
  }
}

/**
 * Provider-declared reset hints, mirroring Hermes' use of `retry-after` /
 * quota reset times. Accepts millisecond deltas, `retry-after` seconds, and
 * wall-clock reset timestamps (anything past one day in ms is a timestamp).
 */
function resetWindowMs(raw: unknown, nowMs: number): number | undefined {
  const record = (raw ?? {}) as Record<string, unknown>;
  for (const key of ['retryAfterMs', 'resetAtMs', 'retry_after_ms'] as const) {
    const value = record[key];
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0) {
      return numeric > 24 * 60 * 60 * 1000 ? Math.max(0, numeric - nowMs) : numeric;
    }
  }
  const seconds =
    typeof record.retryAfter === 'string'
      ? Number(record.retryAfter)
      : typeof record.retryAfter === 'number'
        ? record.retryAfter
        : undefined;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : undefined;
}

function cooldownFor(thrown: unknown, policy: LLMFallbackPolicy, nowMs: number): number {
  const { reason, rateLimited } = classifyFailure(thrown);
  if (!rateLimited) return policy.cooldownMs;
  const reset = resetWindowMs(thrown, nowMs);
  return reset === undefined
    ? policy.maxCooldownMs
    : Math.min(policy.maxCooldownMs, Math.max(policy.cooldownMs, reset));
}

function commitsOutput(event: AssistantMessageEvent): boolean {
  if (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'toolcall_delta'
  ) {
    return event.delta.length > 0;
  }
  if (event.type === 'text_end' || event.type === 'thinking_end') return event.content.length > 0;
  return false;
}

interface PreflightOutcome {
  kind: 'committed' | 'terminal';
  stream?: AssistantMessageEventStream;
  failure?: unknown;
}

/**
 * One preflight pass over a candidate route: buffer provider events until the
 * provider either commits output (success) or fails before any visible token
 * (promotion-eligible). Mirrors the preflight window `withLLMRetry` uses.
 */
async function preflightRoute(
  route: LLMResolvedFallbackRoute,
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2] | undefined,
): Promise<PreflightOutcome> {
  const callerOnResponse = options?.onResponse;
  const attemptOptions = {
    ...(options ?? {}),
    maxRetries: 0,
    ...(route.apiKey ? { apiKey: route.apiKey } : {}),
    ...(route.headers ? { headers: { ...(options?.headers ?? {}), ...route.headers } } : {}),
    onResponse: async (value: ProviderResponse, responseModel: Parameters<StreamFn>[0]) => {
      await callerOnResponse?.(value, responseModel);
    },
  } as SimpleStreamOptions;
  Object.defineProperty(attemptOptions, LLM_RETRY_CALL_IDENTITY, {
    value: {},
    enumerable: true,
  });
  let stream: AssistantMessageEventStream;
  try {
    stream = await route.streamFn(route.model, context, attemptOptions);
  } catch (thrown) {
    return { kind: 'terminal', failure: thrown };
  }
  let iterator: AsyncIterator<AssistantMessageEvent>;
  try {
    iterator = stream[Symbol.asyncIterator]();
  } catch (thrown) {
    return { kind: 'terminal', stream, failure: thrown };
  }
  const buffered: AssistantMessageEvent[] = [];
  for (;;) {
    let next: IteratorResult<AssistantMessageEvent>;
    try {
      next = await iterator.next();
    } catch (thrown) {
      return { kind: 'terminal', stream, iterator, buffered, failure: thrown } as PreflightOutcome;
    }
    if (next.done) {
      try {
        const final = await stream.result();
        if (final?.stopReason === 'error' || final?.stopReason === 'aborted') {
          return { kind: 'terminal', stream, iterator, buffered, failure: final } as PreflightOutcome;
        }
        return { kind: 'committed', stream: replayStream(stream, iterator, buffered) };
      } catch (thrown) {
        return { kind: 'terminal', stream, iterator, buffered, failure: thrown } as PreflightOutcome;
      }
    }
    buffered.push(next.value);
    if (commitsOutput(next.value)) {
      return { kind: 'committed', stream: replayStream(stream, iterator, buffered) };
    }
  }
}

function replayStream(
  source: AssistantMessageEventStream,
  iterator: AsyncIterator<AssistantMessageEvent>,
  buffered: readonly AssistantMessageEvent[],
): AssistantMessageEventStream {
  const replayed: AssistantMessageEvent[] = [...buffered];
  let index = 0;
  const wrapper: AsyncIterator<AssistantMessageEvent> = {
    async next(...args) {
      if (index < replayed.length) {
        const value = replayed[index];
        index += 1;
        return { done: false, value };
      }
      return iterator.next(...args);
    },
    async return(value) {
      return (await iterator.return?.(value)) ?? { done: true, value: undefined };
    },
    async throw(error) {
      return (await iterator.throw?.(error)) ?? { done: true, value: undefined };
    },
  };
  let result: Promise<AssistantMessage> | undefined;
  return {
    [Symbol.asyncIterator]() {
      return wrapper;
    },
    result: () => (result ??= Promise.resolve().then(() => source.result())),
  } as unknown as AssistantMessageEventStream;
}

function throwingStream(failure: unknown): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      throw failure;
    },
    async result() {
      throw failure;
    },
  } as unknown as AssistantMessageEventStream;
}

/**
 * Wrap the primary route's composed StreamFn with the per-agent model chain.
 * Chain `[0]` must be the primary backend; the wrapper runs the full retry
 * policy per candidate via `withLLMRetry`, then promotes to the next healthy
 * candidate only before any output committed.
 */
export function withLLMFallback(inner: StreamFn, input: LLMFallbackOptions): StreamFn {
  const chain = input.chain;
  const fallbackPolicy = { ...DEFAULT_LLM_FALLBACK_POLICY, ...(input.fallbackPolicy ?? {}) };
  const nowMs = input.nowMs ?? Date.now;
  const health = new Map<number, CandidateHealth>();

  const candidateIdentity = (index: number): string => {
    const candidate = chain[index];
    return candidate ? backendIdentityOf(candidate.route.model) : `missing|${index}|`;
  };

  const isAvailable = (index: number): boolean => {
    const state = health.get(index);
    if (!state) return true;
    const now = nowMs();
    if (state.cooldownUntilMs !== undefined && now < state.cooldownUntilMs) return false;
    // Hermes `_should_skip_fallback_candidate`: skip only the exact backend
    // that last failed; a rebuilt endpoint (new baseUrl) re-enters rotation.
    return !(state.lastFailureIdentity && candidateIdentity(index) === state.lastFailureIdentity);
  };

  const runCandidate = async (
    index: number,
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2] | undefined,
  ): Promise<PreflightOutcome> => {
    const candidate = chain[index];
    if (!candidate) return { kind: 'terminal', failure: new Error('fallback chain is empty') };
    const streamFn = withLLMRetry(candidate.route.streamFn, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      scope: input.scope,
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      ...(input.random ? { random: input.random } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    return preflightRoute({ ...candidate.route, streamFn }, context, options);
  };

  const runPrimary = async (
    model: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2] | undefined,
  ): Promise<PreflightOutcome> => {
    const streamFn = withLLMRetry(inner, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      scope: input.scope,
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      ...(input.random ? { random: input.random } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    return preflightRoute({ model, streamFn }, context, options);
  };

  return async (model, context, options) => {
    if (chain.length <= 1) {
      // Single-entry chain: identical to today's retry behavior.
      return withLLMRetry(inner, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        scope: input.scope,
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.random ? { random: input.random } : {}),
        ...(input.sleep ? { sleep: input.sleep } : {}),
      })(model, context, options);
    }
    const primary = await runPrimary(model, context, options);
    if (primary.kind === 'committed') return primary.stream!;
    const primaryFailure = primary.failure;
    if (isAbort(primaryFailure, options?.signal)) return throwingStream(primaryFailure);
    const primaryReason = classifyFailure(primaryFailure).reason;
    const now = nowMs();
    health.set(0, {
      cooldownUntilMs: now + cooldownFor(primaryFailure, fallbackPolicy, now),
      lastFailureIdentity: backendIdentityOf(model),
    });
    for (let index = 1; index < chain.length; index += 1) {
      const candidate = chain[index];
      if (!candidate) continue;
      if (backendIdentityOf(candidate.route.model) === backendIdentityOf(model)) continue;
      if (!isAvailable(index)) {
        const state = health.get(index);
        await notify(input.observer, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          scope: input.scope,
          status: 'cooldown',
          candidateIndex: index,
          fromModel: chain[0]?.modelKey ?? String(model?.id ?? 'primary'),
          toModel: candidate.modelKey,
          reason: primaryReason,
          ...(state?.cooldownUntilMs === undefined
            ? {}
            : { cooldownUntilMs: state.cooldownUntilMs - nowMs() }),
        });
        continue;
      }
      await notify(input.observer, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        scope: input.scope,
        status: 'activated',
        candidateIndex: index,
        fromModel: chain[0]?.modelKey ?? String(model?.id ?? 'primary'),
        toModel: candidate.modelKey,
        reason: primaryReason,
        cooldownUntilMs: health.get(0)?.cooldownUntilMs,
      });
      const attempt = await runCandidate(index, context, options);
      if (attempt.kind === 'committed') return attempt.stream!;
      if (isAbort(attempt.failure, options?.signal)) return throwingStream(attempt.failure);
      const failureAt = nowMs();
      health.set(index, {
        cooldownUntilMs: failureAt + cooldownFor(attempt.failure, fallbackPolicy, failureAt),
        lastFailureIdentity: candidateIdentity(index),
      });
    }
    const exhausted = new Error(
      `Model chain exhausted after ${chain.length} candidate(s); last failure: ${primaryReason}`,
    );
    await notify(input.observer, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      scope: input.scope,
      status: 'exhausted',
      candidateIndex: Math.max(0, chain.length - 1),
      fromModel: chain[chain.length - 1]?.modelKey ?? chain[0]?.modelKey ?? 'primary',
      reason: primaryReason,
    });
    return throwingStream(exhausted);
  };
}

async function notify(
  observer: LLMFallbackOptions['observer'],
  event: LLMFallbackEvent,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(event);
  } catch {
    // Failover observability must never change provider-call behavior.
  }
}

/**
 * Bounded chain parser shared by the canonical file codec and the agent
 * config document: keeps `provider/model` entries, drops duplicates and
 * malformed keys, caps at `limit` (chain order is declared by the caller).
 */
export function normalizeModelChain(
  value: readonly string[] | undefined,
  limit = 3,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const entry of value) {
    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    const slash = trimmed.indexOf('/');
    if (!trimmed || slash <= 0 || slash === trimmed.length - 1) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    chain.push(trimmed);
    if (chain.length >= limit) break;
  }
  return chain.length > 0 ? Object.freeze(chain) : undefined;
}

/**
 * Resolves a host-declared `provider/model` chain into concrete routes.
 * Entries the host cannot resolve (unknown provider, missing credential) are
 * dropped — an unresolvable candidate must never take down the primary.
 * Returns [] when nothing resolves, which callers treat as "no chain"
 * (plain retry-only behavior).
 */
export async function resolveFallbackChain(
  modelKeys: readonly string[],
  resolve: (modelKey: string) => Promise<LLMResolvedFallbackRoute | undefined>,
): Promise<LLMFallbackCandidate[]> {
  const candidates: LLMFallbackCandidate[] = [];
  for (const modelKey of modelKeys) {
    const route = await resolve(modelKey).catch(() => undefined);
    if (!route) continue;
    candidates.push({ modelKey, route });
  }
  return candidates;
}

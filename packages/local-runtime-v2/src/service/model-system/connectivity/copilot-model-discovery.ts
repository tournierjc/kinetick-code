import type { LocalCustomProviderConfig, LocalModelConfig } from '../contracts.js';
import type { ModelProviderApi } from '../identity.js';

/** Copilot API base when the account token does not name a proxy endpoint. */
export const COPILOT_API_BASE_URL = 'https://api.githubcopilot.com';

const COPILOT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Static editor attribution the Copilot API requires.
 *
 * Pi's own transports add the *dynamic* per-request headers (`X-Initiator`,
 * `Openai-Intent`, `Copilot-Vision-Request`) for `provider === 'github-copilot'`,
 * and pi's generated Copilot models declare these editor headers per model. A
 * provider assembled from a live catalog has no such declaration, so the
 * connector states them here and writes them as provider options.
 */
export function copilotEditorHeaders(): Record<string, string> {
  return {
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'Copilot-Integration-Id': 'vscode-chat',
  };
}

/**
 * API base declared by a Copilot account token.
 *
 * The exchanged token carries `proxy-ep=proxy.<host>;`, and the editor API for
 * that account is `api.<host>` (individual, business and enterprise accounts
 * resolve to different hosts).
 */
export function copilotBaseUrlFromToken(token: string): string | undefined {
  const match = /proxy-ep=([^;]+)/u.exec(token);
  const proxyHost = match?.[1]?.trim();
  if (!proxyHost) return undefined;
  const apiHost = proxyHost.replace(/^proxy\./u, 'api.');
  return /^[\w.-]+$/u.test(apiHost) ? `https://${apiHost}` : undefined;
}

export interface CopilotModelCredentials {
  readonly token: string;
  /** Overrides the account proxy endpoint; defaults to the individual host. */
  readonly baseUrl?: string;
}

export interface CopilotModelCatalog {
  readonly provider: LocalCustomProviderConfig;
  /**
   * Picker-visible models this account cannot call yet (`policy.state:
   * 'disabled'`). GitHub answers such a model with `model_not_supported`, and
   * accepting the linked terms for the account is what clears it — the API's own
   * `POST /models/<id>/policy` returns 200 without changing the state, so the
   * connector reports these instead of pretending to enable them.
   */
  readonly policyOptInRequired: readonly string[];
}

/**
 * Reads the account's Copilot catalog from the live `/models` endpoint.
 *
 * The catalog — not a checked-in table — is the authority for context limits
 * and for the reasoning-effort levels the account can actually select, because
 * both vary per account and per rollout. Every model therefore carries the
 * `context`/`output` limits and the `thinking.effortOptions` reported for that
 * account, and the wire protocol each model advertises.
 */
/**
 * A discovery request the service answered with a non-OK status.
 *
 * A dedicated class rather than a shaped message: the caller recognises its own
 * failure, and a reader of the catch block sees which failure survives instead of
 * inferring it from a regular expression over `error.message`. It carries the
 * status and nothing else — a response body may echo the bearer token.
 */
export class CopilotModelDiscoveryHttpError extends Error {
  constructor(readonly status: number) {
    super(`Copilot model discovery failed (HTTP ${status}).`);
    this.name = 'CopilotModelDiscoveryHttpError';
  }
}

export class CopilotModelDiscoveryClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = COPILOT_REQUEST_TIMEOUT_MS,
  ) {}

  async discover(credentials: CopilotModelCredentials): Promise<CopilotModelCatalog> {
    const payload = await this.request(credentials, '/models');
    return parseCatalog(payload);
  }

  private baseHeaders(token: string): Record<string, string> {
    return {
      ...copilotEditorHeaders(),
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    };
  }

  private async request(credentials: CopilotModelCredentials, path: string): Promise<unknown> {
    const baseUrl = (credentials.baseUrl ?? COPILOT_API_BASE_URL).replace(/\/+$/u, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: this.baseHeaders(credentials.token),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new CopilotModelDiscoveryHttpError(response.status);
      }
      return await response.json();
    } catch (error) {
      // Never forward a response body or transport error: both can carry the bearer token.
      if (error instanceof CopilotModelDiscoveryHttpError) throw error;
      throw new Error('Copilot model discovery failed. Retry connecting or reopen model settings.');
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseCatalog(payload: unknown): CopilotModelCatalog {
  const records = readRecord(payload)?.data;
  if (!Array.isArray(records)) throw new Error('Invalid Copilot model catalog.');
  const entries: [string, LocalModelConfig][] = [];
  const policyOptInRequired: string[] = [];
  for (const item of records) {
    const model = readRecord(item);
    if (!model) continue;
    const id = readString(model.id);
    if (!id || !isSelectableCopilotModel(model)) continue;
    const api = copilotApiForEndpoints(model.supported_endpoints);
    if (!api) continue;
    entries.push([id, parseModel(model, id, api)]);
    if (readPolicyState(model) === 'disabled') policyOptInRequired.push(id);
  }
  if (entries.length === 0) throw new Error('Empty Copilot model catalog.');
  return {
    provider: {
      api: 'openai-completions',
      name: 'GitHub Copilot',
      kind: 'oauth',
      enabled: true,
      options: {
        authMode: 'oauth',
        baseURL: COPILOT_API_BASE_URL,
        headers: copilotEditorHeaders(),
      },
      models: Object.fromEntries(entries),
    },
    policyOptInRequired,
  };
}

/** `policy.state` is absent on accounts and models that need no opt-in. */
function readPolicyState(model: Record<string, unknown>): string | undefined {
  return readString(readRecord(model.policy)?.state)?.toLowerCase();
}

/** Chat models this account can pick. Internal, embedding and hidden entries are dropped. */
function isSelectableCopilotModel(model: Record<string, unknown>): boolean {
  const capabilities = readRecord(model.capabilities);
  const type = readString(capabilities?.type)?.toLowerCase();
  if (type && type !== 'chat') return false;
  return model.model_picker_enabled !== false;
}

/**
 * Wire protocol from the model's advertised endpoints.
 *
 * Messages wins over Responses which wins over Chat Completions: Copilot's
 * Claude models answer natively on `/v1/messages`, the GPT-5 family is
 * Responses-first, and the remaining models are completions-only.
 */
function copilotApiForEndpoints(value: unknown): ModelProviderApi | undefined {
  const endpoints = readEndpoints(value);
  if (endpoints.has('/v1/messages')) return 'anthropic-messages';
  if (endpoints.has('/responses')) return 'openai-responses';
  if (endpoints.has('/chat/completions')) return 'openai-completions';
  return undefined;
}

function readEndpoints(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.flatMap((entry): string[] => {
      const endpoint = readString(entry);
      // `ws:/responses` is a streaming transport, not a request path.
      return endpoint && !endpoint.startsWith('ws:') ? [endpoint] : [];
    }),
  );
}

function parseModel(
  model: Record<string, unknown>,
  id: string,
  api: ModelProviderApi,
): LocalModelConfig {
  const capabilities = readRecord(model.capabilities);
  const limits = readRecord(capabilities?.limits);
  const supports = readRecord(capabilities?.supports);
  const effortOptions = readEfforts(supports?.reasoning_effort);
  const vision = supports?.vision === true;
  // The account reports both the full window (prompt + output) and the prompt
  // budget the API accepts; the prompt budget is what this runtime admits.
  const context =
    readPositiveInteger(limits?.max_prompt_tokens) ??
    readPositiveInteger(limits?.max_context_window_tokens);
  const output = readPositiveInteger(limits?.max_output_tokens);
  return {
    name: readString(model.name) ?? id,
    reasoning: effortOptions.length > 0,
    attachment: vision,
    tool_call: supports?.tool_calls !== false,
    modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] },
    ...(context || output
      ? {
          limit: {
            ...(context ? { context } : {}),
            ...(output ? { output } : {}),
          },
        }
      : {}),
    ...(effortOptions.length > 0 ? { thinking: { effortOptions } } : {}),
    provider: { api },
  };
}

/** Effort levels as the account reports them, in rollout order. */
function readEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const efforts: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const effort = readString(entry)?.toLowerCase();
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

import type { ModelProviderApi } from '../identity.js';

/**
 * What this fork knows about a provider family that its `models.dev` entry cannot
 * say: the thinking shape its OpenAI-compatible endpoint expects, and the effort
 * levels that endpoint accepts.
 *
 * Both matter on the wire. `openai-completions` requests are generic by default —
 * a bare `reasoning_effort` — while some endpoints take a `thinking` object
 * instead, and accept only their own vocabulary of levels. Sending the generic
 * shape cannot express "thinking off" there, and a level the endpoint does not
 * publish is refused. The upstream product keeps this knowledge per provider;
 * this table is the same idea in one place, so a provider stops being a base URL
 * with a model list and becomes an endpoint with behaviour.
 */
export interface ProviderFamily {
  /** Provider key this family is configured under, e.g. `custom_provider.deepseek`. */
  readonly providerId: string;
  readonly displayName: string;
  /** Hostnames serving the family's endpoint, matched on the configured base URL. */
  readonly hosts: readonly string[];
  /** models.dev `npm` packages that serve this family. */
  readonly npm: readonly string[];
  readonly apiFormat: ModelProviderApi;
  /** `openai-completions` thinking shape this endpoint expects. */
  readonly thinkingFormat?: 'deepseek' | 'openrouter';
  /** Reasoning levels the endpoint publishes, ascending. */
  readonly effortOptions?: readonly string[];
  /** Model-id prefixes that carry the family's reasoning behaviour. */
  readonly modelIdPrefixes?: readonly string[];
  /** Model-id prefixes excluded from `modelIdPrefixes`, e.g. a non-thinking generation. */
  readonly modelIdExcludes?: readonly string[];
  /** Whether the family is offered among the pinned presets. */
  readonly pinned?: boolean;
  /**
   * Whether the fork keeps this family pinned even when the remote pin list
   * omits it. Reserved for families MiniMax's own shelf will never sell (an
   * aggregator competing with the product's managed plans); for families MiniMax
   * does sell, the remote shelf may retire the pin.
   */
  readonly forkAnchored?: boolean;
}

/**
 * DeepSeek's V4 family: thinking defaults on, `thinking` carries the switch, and
 * the levels are low/medium/high/max. V3 has no thinking mode, so it is excluded
 * rather than left to inherit the V4 shape.
 */
const DEEPSEEK: ProviderFamily = {
  providerId: 'deepseek',
  displayName: 'DeepSeek',
  hosts: ['api.deepseek.com'],
  npm: ['@ai-sdk/deepseek', '@ai-sdk/openai-compatible'],
  apiFormat: 'openai-completions',
  thinkingFormat: 'deepseek',
  effortOptions: ['low', 'medium', 'high', 'max'],
  modelIdPrefixes: ['deepseek-v'],
  modelIdExcludes: ['deepseek-v3'],
  pinned: true,
};

/**
 * OpenRouter is an aggregator: one endpoint, many upstream providers, and its
 * own `reasoning` object carrying the level, rather than a bare
 * `reasoning_effort`. Its catalog advertises per-model `supported_efforts`, so
 * this family deliberately declares no level vocabulary — clamping a level to
 * what the route publishes is a separate concern from sending the right shape,
 * and inventing levels here would be worse than offering none.
 */
const OPENROUTER: ProviderFamily = {
  providerId: 'openrouter',
  displayName: 'OpenRouter',
  hosts: ['openrouter.ai'],
  npm: ['@openrouter/ai-sdk-provider'],
  apiFormat: 'openai-completions',
  thinkingFormat: 'openrouter',
  pinned: true,
  forkAnchored: true,
};

export const PROVIDER_FAMILIES: readonly ProviderFamily[] = [DEEPSEEK, OPENROUTER];

export interface ProviderFamilyLookup {
  /** Provider key from the configuration, e.g. `deepseek`. */
  readonly providerId?: string;
  readonly baseUrl?: string;
  readonly modelId?: string;
}

function hostnameOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether the configured endpoint belongs to the family. */
function familyServesHost(family: ProviderFamily, hostname: string | undefined): boolean {
  if (!hostname) return false;
  return family.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** Whether the model id belongs to the family's reasoning generations. */
function familyServesModelId(family: ProviderFamily, modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  if (family.modelIdExcludes?.some((prefix) => id.startsWith(prefix))) return false;
  return Boolean(family.modelIdPrefixes?.some((prefix) => id.startsWith(prefix)));
}

/** Whether the family's reasoning behaviour applies to this model id. */
export function providerFamilyServesModel(
  family: ProviderFamily,
  modelId: string | undefined,
): boolean {
  return familyServesModelId(family, modelId);
}

/**
 * Resolves the family for a configured provider.
 *
 * The provider key is checked first, because it is what the user chose, then the
 * endpoint, then the model id. A provider named `deepseek` that points at an echo
 * server is still DeepSeek for the purpose of the request shape; a provider named
 * anything else that points at `api.deepseek.com` is DeepSeek too.
 */
export function providerFamilyForLookup(
  lookup: ProviderFamilyLookup,
): ProviderFamily | undefined {
  const providerId = lookup.providerId?.trim().toLowerCase();
  const hostname = hostnameOf(lookup.baseUrl);
  for (const family of PROVIDER_FAMILIES) {
    if (providerId && family.providerId === providerId) return family;
    if (familyServesHost(family, hostname)) return family;
  }
  for (const family of PROVIDER_FAMILIES) {
    if (familyServesModelId(family, lookup.modelId)) return family;
  }
  return undefined;
}

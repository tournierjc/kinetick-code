import {
  getModels,
  getProviders,
  type Api,
  type Model,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import type { StreamFn, ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  isFirstPartyMinimaxMessagesRoute,
  resolveProviderAuthMode,
  type ProviderAuthMode,
  type ProviderAuthModeSource,
} from '@mavis/config';
import { ThinkingLevel, type IAgentConfig, type IModelRef } from '@mavis/protocol';
import type { ManagedBackendRoutingContext } from '@mavis/agent-tools/desktop';
import { withOpenCodeGoHeaders, withOpenRouterAttributionHeaders } from '@mavis/shared';

import type {
  LocalModelCompatOverrides,
  LocalModelConfig,
  LocalModelResolveInput,
  LocalModelResolverLike,
  LocalModelResolverLogger,
  LocalModelResolverOptions,
  LocalResolvedModelConfig,
  LocalModelsConfig,
  LocalProviderOptions,
  LocalRuntimeAuthContext,
} from '../contracts.js';
import { normalizeProviderBaseUrl, UNAUTHENTICATED_PROVIDER_API_KEY } from '../connectivity/provider-request.js';
import {
  isModelProviderApi,
  MANAGED_MINIMAX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from '../identity.js';
import { parseProviderId } from './model-key.js';
import {
  isMiniMaxM3ModelId,
  isMiniMaxM3ThinkingMode,
  type ByokThinkingProtocol,
  isThinkingEffortDisabled,
  modelRefForModel,
  readSelectedThinkingEffort,
  resolveByokThinkingProtocol,
  supportsJsonObjectOutput,
} from './model-ref.js';
import {
  firstBuiltinModel,
  planCustomProviderResolution,
  planMinimaxApiResolution,
  readStringRecord,
} from './model-resolver-byok.js';
import {
  buildLocalProviderHeaders,
  createManagedAuthRetryFetch,
  readAgentHeaderId,
  stripUrlCredentials,
} from './model-resolver-helpers.js';
import { hasOpenPlatformThinkingVariants } from './openplatform-thinking.js';
import { withByokErrorAttribution } from './byok-error-attribution.js';
import { withLocalDynamicMaxTokens } from './dynamic-max-tokens.js';
import { resolveLocalFileApiGatewayAuth } from './file-api-gateway-auth.js';

const FALLBACK_MODEL_LIMITS = {
  contextWindow: 200_000,
  maxTokens: 128_000,
} as const;

const DEFAULT_LOCAL_PI_API: Api = 'anthropic-messages';
const MANAGED_PROVIDER_API_KEY_PLACEHOLDER = 'sk-xxx';

const THINKING_LEVEL_TO_PI: Record<ThinkingLevel, PiThinkingLevel> = {
  [ThinkingLevel.OFF]: 'off',
  [ThinkingLevel.MINIMAL]: 'minimal',
  [ThinkingLevel.LOW]: 'low',
  [ThinkingLevel.MEDIUM]: 'medium',
  [ThinkingLevel.HIGH]: 'high',
  [ThinkingLevel.XHIGH]: 'xhigh',
};

interface ModelIdentity {
  readonly modelRef: IModelRef;
  readonly provider: string;
  readonly modelId: string;
}

type ByokResolutionPlan = NonNullable<ReturnType<typeof planMinimaxApiResolution>>;

interface SelectedModel {
  readonly identity: ModelIdentity;
  readonly byokPlan?: ByokResolutionPlan;
  readonly route?: string;
}

interface FinishResolveInput extends ModelIdentity {
  readonly sessionId: string;
  readonly agentConfig: IAgentConfig;
  readonly api: Api;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly managedProvider: boolean;
  readonly byokProvider: boolean;
  readonly customProvider: boolean;
  readonly runtimeProvider?: string;
  readonly configHeaders?: Record<string, string>;
  /**
   * The endpoint declares no credential: no key is sent in the request, and
   * none is required to reach it.
   */
  readonly unauthenticatedEndpoint?: true;
  readonly modelCompat?: LocalModelCompatOverrides;
  /**
   * Token rates the provider declares for this model, in USD per million tokens.
   * The config subtree it comes from is persisted as opaque JSON, so the rate is
   * validated where it is read rather than where it is written.
   */
  readonly modelCost?: LocalModelConfig['cost'];
  readonly catalogModel?: Model<Api>;
  readonly authContext?: LocalRuntimeAuthContext;
  readonly routingContext?: ManagedBackendRoutingContext;
}

export class LocalModelResolver implements LocalModelResolverLike {
  private readonly defaultApi: Api;

  constructor(private readonly options: LocalModelResolverOptions = {}) {
    this.defaultApi = options.defaultApi ?? DEFAULT_LOCAL_PI_API;
  }

  async resolveModel(input: LocalModelResolveInput): Promise<LocalResolvedModelConfig> {
    const providerConfig = this.options.providerConfigGetter?.() ?? this.options.providerConfig;
    const selected = selectModel(input.agentConfig, providerConfig, this.options);
    if (selected.byokPlan) return this.finishByok(input, selected);
    const switched = selectMinimaxByok(selected.identity, providerConfig, this.options);
    if (switched.byokPlan) return this.finishByok(input, switched);
    return this.resolveManagedModel(input, switched.identity, providerConfig);
  }

  private async finishByok(
    input: LocalModelResolveInput,
    selected: SelectedModel,
  ): Promise<LocalResolvedModelConfig> {
    const plan = selected.byokPlan;
    if (!plan || !selected.route) {
      throw new Error('LocalModelResolver: incomplete BYOK resolution plan');
    }
    const resolvedPlan = await resolveByokResolutionPlan(plan, this.options);
    this.logRoute(selected.identity.provider, selected.identity.modelId, selected.route);
    return this.finishResolve({
      sessionId: input.sessionId,
      agentConfig: input.agentConfig,
      ...selected.identity,
      managedProvider: false,
      byokProvider: true,
      customProvider: selected.route === 'custom_provider' && !plan.authProvider,
      ...(plan.runtimeProvider
        ? {
            catalogModel: lookupLocalCatalogModel(plan.runtimeProvider, selected.identity.modelId),
          }
        : {}),
      ...resolvedPlan,
    });
  }

  private async resolveManagedModel(
    input: LocalModelResolveInput,
    identity: ModelIdentity,
    providerConfig: LocalModelsConfig | undefined,
  ): Promise<LocalResolvedModelConfig> {
    const { provider, modelId, modelRef } = identity;
    const currentAuthContext = this.options.authContextGetter?.();
    const authContext = currentAuthContext ? { ...currentAuthContext } : undefined;
    const routingContext = this.options.routingContextGetter?.();
    const credentials = resolveLocalProviderCredentials(
      provider,
      modelRef,
      providerConfig,
      authContext,
    );
    const limits = lookupLocalModelLimits(provider, modelId);
    const openAiCodex = provider === OPENAI_CODEX_PROVIDER_ID;
    const apiKey = await resolveProviderApiKey(provider, credentials.apiKey, this.options);
    const baseUrl = credentials.baseUrl ?? (openAiCodex ? limits.baseUrl : undefined);
    const usable = requireUsableCredentials(provider, apiKey, baseUrl, credentials);
    this.logRoute(provider, modelId, providerRouteForAuthMode(credentials.authMode));
    return this.finishResolve({
      sessionId: input.sessionId,
      agentConfig: input.agentConfig,
      ...identity,
      api: limits.api ?? this.defaultApi,
      apiKey: usable.apiKey,
      baseUrl: usable.baseUrl,
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
      managedProvider: credentials.authMode === 'managed-login',
      byokProvider: credentials.authMode === 'oauth',
      customProvider: false,
      configHeaders: credentials.headers,
      ...(usable.unauthenticatedEndpoint ? { unauthenticatedEndpoint: true as const } : {}),
      catalogModel: lookupLocalCatalogModel(provider, modelId),
      ...(authContext ? { authContext } : {}),
      ...(routingContext ? { routingContext } : {}),
    });
  }

  private finishResolve(input: FinishResolveInput): LocalResolvedModelConfig {
    const contextWindow = positive(input.modelRef.context_window) || input.contextWindow;
    const maxTokens = positive(input.modelRef.max_tokens) || input.maxTokens;
    const thinking = resolveThinking(input, this.options.implicitCustomProviderThinking === true);
    const baseUrl = normalizeResolvedBaseUrl(input.api, input.baseUrl);
    const maxRequestBodyBytes = normalizeResolvedRequestBodyAdmissionLimit(
      input.modelRef.capabilities?.max_request_body_bytes,
    );
    const model = buildResolvedModel({ input, contextWindow, maxTokens, baseUrl, thinking });
    const streamFn = resolveModelStream(input, this.options.streamFn);
    const fileApiGatewayAuth = input.managedProvider
      ? resolveLocalFileApiGatewayAuth(input.authContext, input.routingContext)
      : undefined;
    const fetchImpl = resolveModelFetch(input, this.options);
    this.options.logger?.info(
      {
        sessionId: input.sessionId,
        provider: input.provider,
        modelId: input.modelId,
        api: input.api,
        baseUrl,
        managed: input.managedProvider,
        contextWindow,
        maxTokens,
        reasoning: thinking.enabled,
      },
      'Resolved local conversation model',
    );
    return {
      model,
      managedProvider: input.managedProvider,
      supportsJsonObjectOutput: supportsJsonObjectOutput(input.modelRef),
      apiKey: input.apiKey,
      maxTokens,
      ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
      headers: buildLocalProviderHeaders({
        headers: withOpenCodeGoHeaders(
          baseUrl,
          withOpenRouterAttributionHeaders(baseUrl, input.configHeaders),
          input.sessionId,
        ),
        managedProvider: input.managedProvider,
        routingContext: input.routingContext,
        sessionId: input.sessionId,
        agentId: readAgentHeaderId(input.agentConfig),
      }),
      ...(fileApiGatewayAuth ? { fileApiGatewayAuth } : {}),
      ...(streamFn ? { streamFn } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(thinking.exposedLevel ? { thinkingLevel: thinking.exposedLevel } : {}),
      ...(thinking.requestPatch ? { thinkingRequestPatch: thinking.requestPatch } : {}),
      ...(input.unauthenticatedEndpoint ? { unauthenticatedEndpoint: true as const } : {}),
    };
  }

  private logRoute(provider: string, modelId: string, route: string): void {
    this.options.logger?.info(
      { provider, modelId, route },
      'Resolved local conversation model route',
    );
  }
}

function resolveModelFetch(
  input: FinishResolveInput,
  options: LocalModelResolverOptions,
): LocalResolvedModelConfig['fetch'] {
  return input.managedProvider
    ? createManagedAuthRetryFetch({ ...options, authContext: input.authContext })
    : options.fetchImpl;
}

function selectModel(
  agentConfig: IAgentConfig,
  providerConfig: LocalModelsConfig | undefined,
  options: LocalModelResolverOptions,
): SelectedModel {
  const identity = requireModelIdentity(agentConfig);
  const parsed = parseProviderId(identity.provider);
  if (!parsed || parsed.source === 'provider') return { identity };
  const byokPlan = selectExternalByokPlan(identity, parsed, providerConfig, options);
  if (byokPlan) return { identity, byokPlan, route: parsed.source };
  return {
    identity: fallbackBuiltinIdentity(identity, providerConfig, options.logger),
  };
}

function requireModelIdentity(agentConfig: IAgentConfig): ModelIdentity {
  const modelRef = agentConfig.model;
  if (!modelRef) throw new Error('LocalModelResolver: agentConfig.model is required');
  const provider = modelRef.provider?.trim() ?? '';
  const modelId = modelRef.model_id?.trim() ?? '';
  if (!provider) throw new Error('LocalModelResolver: ModelRef.provider is required');
  if (!modelId) throw new Error('LocalModelResolver: ModelRef.model_id is required');
  return { modelRef, provider, modelId };
}

function selectExternalByokPlan(
  identity: ModelIdentity,
  parsed: NonNullable<ReturnType<typeof parseProviderId>>,
  providerConfig: LocalModelsConfig | undefined,
  options: LocalModelResolverOptions,
): ByokResolutionPlan | undefined {
  if (parsed.source === 'minimax_api') {
    return planMinimaxApiResolution({
      byok: options.byokConfigGetter?.(),
      providerConfig,
      modelId: identity.modelId,
      catalog: lookupLocalModelLimits(MANAGED_MINIMAX_PROVIDER_ID, identity.modelId),
    });
  }
  return planCustomProviderResolution({
    byok: options.byokConfigGetter?.(),
    provider: identity.provider,
    providerKey: parsed.providerKey,
    modelId: identity.modelId,
  });
}

function fallbackBuiltinIdentity(
  original: ModelIdentity,
  providerConfig: LocalModelsConfig | undefined,
  logger: LocalModelResolverLogger | undefined,
): ModelIdentity {
  const fallback = firstBuiltinModel(providerConfig);
  if (!fallback) {
    throw new Error(
      `LocalModelResolver: provider "${original.provider}" not found and no builtin fallback model is configured.`,
    );
  }
  logger?.warn(
    {
      provider: original.provider,
      fallbackProvider: fallback.provider,
      fallbackModelId: fallback.modelId,
    },
    'LocalModelResolver: provider not found; falling back to builtin managed model',
  );
  return {
    provider: fallback.provider,
    modelId: fallback.modelId,
    modelRef: modelRefForModel(
      fallback.provider,
      fallback.modelId,
      providerConfig?.[fallback.provider]?.models?.[fallback.modelId],
    ),
  };
}

function selectMinimaxByok(
  identity: ModelIdentity,
  providerConfig: LocalModelsConfig | undefined,
  options: LocalModelResolverOptions,
): SelectedModel {
  const byok = options.byokConfigGetter?.();
  if (
    identity.provider !== MANAGED_MINIMAX_PROVIDER_ID ||
    byok?.minimaxModelSource !== 'minimax_api_key'
  ) {
    return { identity };
  }
  const byokPlan = planMinimaxApiResolution({
    byok,
    providerConfig,
    modelId: identity.modelId,
    catalog: lookupLocalModelLimits(MANAGED_MINIMAX_PROVIDER_ID, identity.modelId),
  });
  return byokPlan ? { identity, byokPlan, route: 'minimax_api_key' } : { identity };
}

async function resolveProviderApiKey(
  provider: string,
  configuredApiKey: string | undefined,
  options: LocalModelResolverOptions,
): Promise<string | undefined> {
  if (provider !== OPENAI_CODEX_PROVIDER_ID) return configuredApiKey;
  return (await options.providerAuthGetter?.(provider))?.trim();
}

type ResolvedByokResolutionPlan = Omit<ByokResolutionPlan, 'apiKey' | 'authProvider'> & {
  readonly apiKey: string;
};

async function resolveByokResolutionPlan(
  plan: ByokResolutionPlan,
  options: LocalModelResolverOptions,
): Promise<ResolvedByokResolutionPlan> {
  const {
    authProvider,
    apiKey: configuredApiKey,
    unauthenticatedEndpoint,
    ...resolved
  } = plan;
  // An endpoint that declares no credential resolves to the placeholder key the
  // transport requires; `unauthenticatedEndpoint` clears the credential header
  // that key would otherwise be written into, so nothing is sent in its place.
  if (unauthenticatedEndpoint) {
    return { ...resolved, apiKey: UNAUTHENTICATED_PROVIDER_API_KEY, unauthenticatedEndpoint: true };
  }
  const apiKey = (
    authProvider ? await options.providerAuthGetter?.(authProvider) : configuredApiKey
  )?.trim();
  if (!apiKey) {
    throw new Error(
      authProvider
        ? `LocalModelResolver: ${authProvider} login required; no OAuth credentials found.`
        : `LocalModelResolver: api_key not configured for provider "${plan.provider}".`,
    );
  }
  return { ...resolved, apiKey };
}

interface ResolvedThinking {
  readonly enabled: boolean;
  readonly openPlatform: boolean;
  readonly exposedLevel?: PiThinkingLevel;
  readonly maxLevel?: string;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly requestPatch?: Readonly<Record<string, unknown>>;
  readonly forceAdaptiveThinking?: true;
  readonly completionsThinkingCompat?: {
    readonly thinkingFormat: 'openai';
    readonly supportsReasoningEffort: true;
  };
}

interface ThinkingResolutionContext {
  readonly enabled: boolean;
  readonly openPlatform: boolean;
  readonly protocolThinking?: ByokThinkingProtocol;
  readonly piLevel?: PiThinkingLevel;
  readonly shouldExposeLevel: boolean;
  readonly maxLevel?: string;
}

function resolveThinking(
  input: FinishResolveInput,
  implicitCustomProviderThinking: boolean,
): ResolvedThinking {
  const context = resolveThinkingContext(input, implicitCustomProviderThinking);
  return {
    enabled: context.enabled,
    openPlatform: context.openPlatform,
    ...exposedThinkingLevel(context),
    ...thinkingLevelMapFields(context),
    ...thinkingRequestPatchFields(context),
    ...maxThinkingLevelFields(context),
    ...thinkingCompatibilityFields(context),
  };
}

function resolveThinkingContext(
  input: FinishResolveInput,
  implicitCustomProviderThinking: boolean,
): ThinkingResolutionContext {
  const thinkingLevel = input.modelRef.thinking_level;
  const thinkingToggleOn = isThinkingToggleOn(thinkingLevel);
  const selectedEffort =
    input.modelRef.thinking_effort ??
    readSelectedThinkingEffort(input.modelRef.capabilities as Record<string, unknown> | undefined);
  const protocolThinking = resolveConfiguredThinkingProtocol(
    input,
    thinkingToggleOn,
    selectedEffort,
  );
  const openPlatform = hasOpenPlatformThinkingVariants(input.modelRef);
  const enabled = resolveThinkingEnabled({
    customProvider: input.customProvider,
    implicitCustomProviderThinking,
    openPlatform,
    thinkingToggleOn,
    selectedEffort,
    protocolThinking,
  });
  return {
    enabled,
    openPlatform,
    ...(protocolThinking ? { protocolThinking } : {}),
    ...resolvePiThinkingLevel({
      enabled,
      protocolThinking,
      selectedEffort,
      thinkingLevel,
      modelId: input.modelId,
    }),
    shouldExposeLevel: shouldExposeThinkingLevel({
      input,
      enabled,
      protocolThinking,
      openPlatform,
      implicitCustomProviderThinking,
    }),
    ...resolveCatalogMaxThinkingLevel(selectedEffort, input.catalogModel),
  };
}

function isThinkingToggleOn(thinkingLevel: ThinkingLevel | undefined): boolean {
  return thinkingLevel !== undefined && thinkingLevel !== ThinkingLevel.OFF;
}

function resolveConfiguredThinkingProtocol(
  input: FinishResolveInput,
  thinkingToggleOn: boolean,
  selectedEffort: string | undefined,
): ByokThinkingProtocol | undefined {
  const configurable = input.customProvider || input.api === 'openai-codex-responses';
  if (!configurable || (!thinkingToggleOn && !selectedEffort)) return undefined;
  const api = supportedByokThinkingApi(input.api);
  return api ? resolveByokThinkingProtocol(api, selectedEffort, input.modelId) : undefined;
}

function supportedByokThinkingApi(api: Api): Api | undefined {
  return isModelProviderApi(api) || api === 'openai-codex-responses' ? api : undefined;
}

function resolveThinkingEnabled(input: {
  readonly customProvider: boolean;
  readonly implicitCustomProviderThinking: boolean;
  readonly openPlatform: boolean;
  readonly thinkingToggleOn: boolean;
  readonly selectedEffort?: string;
  readonly protocolThinking?: ByokThinkingProtocol;
}): boolean {
  if (isThinkingEffortDisabled(input.selectedEffort)) return false;
  if (input.selectedEffort) return true;
  if (!input.customProvider || input.openPlatform) return input.thinkingToggleOn;
  if (input.protocolThinking) return input.protocolThinking.enabled !== false;
  return input.implicitCustomProviderThinking && input.thinkingToggleOn;
}

function resolvePiThinkingLevel(input: {
  readonly enabled: boolean;
  readonly protocolThinking: ByokThinkingProtocol | undefined;
  readonly selectedEffort: string | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly modelId: string;
}): Pick<ThinkingResolutionContext, 'piLevel'> {
  if (!input.enabled) return {};
  const piLevel =
    input.protocolThinking?.piLevel ??
    selectedEffortPiLevel(input.selectedEffort, input.thinkingLevel, input.modelId) ??
    piThinkingLevelFor(input.thinkingLevel);
  return piLevel ? { piLevel } : {};
}

function selectedEffortPiLevel(
  selectedEffort: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  modelId: string | undefined,
): PiThinkingLevel | undefined {
  if (isMiniMaxM3ModelId(modelId) && isMiniMaxM3ThinkingMode(selectedEffort)) {
    return piThinkingLevelFor(thinkingLevel);
  }
  return selectedEffort as PiThinkingLevel | undefined;
}

function piThinkingLevelFor(thinkingLevel: ThinkingLevel | undefined): PiThinkingLevel | undefined {
  return thinkingLevel === undefined ? undefined : THINKING_LEVEL_TO_PI[thinkingLevel];
}

function shouldExposeThinkingLevel(options: {
  readonly input: FinishResolveInput;
  readonly enabled: boolean;
  readonly protocolThinking?: ByokThinkingProtocol;
  readonly openPlatform: boolean;
  readonly implicitCustomProviderThinking: boolean;
}): boolean {
  if (!options.enabled) return false;
  return (
    options.protocolThinking !== undefined ||
    options.input.api !== 'anthropic-messages' ||
    options.openPlatform ||
    (options.implicitCustomProviderThinking && options.input.customProvider)
  );
}

function resolveCatalogMaxThinkingLevel(
  selectedEffort: string | undefined,
  catalogModel: Model<Api> | undefined,
): Pick<ThinkingResolutionContext, 'maxLevel'> {
  const maxLevel = catalogModel?.thinkingLevelMap?.max;
  return selectedEffort === 'max' && typeof maxLevel === 'string' ? { maxLevel } : {};
}

function exposedThinkingLevel(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'exposedLevel'> {
  return context.shouldExposeLevel && context.piLevel ? { exposedLevel: context.piLevel } : {};
}

function thinkingLevelMapFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'thinkingLevelMap'> {
  return context.enabled && context.protocolThinking
    ? { thinkingLevelMap: context.protocolThinking.thinkingLevelMap }
    : {};
}

function thinkingRequestPatchFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'requestPatch'> {
  return context.protocolThinking ? { requestPatch: context.protocolThinking.requestPatch } : {};
}

function maxThinkingLevelFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'maxLevel'> {
  return context.maxLevel ? { maxLevel: context.maxLevel } : {};
}

function thinkingCompatibilityFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'forceAdaptiveThinking' | 'completionsThinkingCompat'> {
  if (!context.enabled || !context.protocolThinking) return {};
  if (context.protocolThinking.forceAdaptiveThinking) return { forceAdaptiveThinking: true };
  if (context.protocolThinking.completionsThinkingFormat === 'openai') {
    return {
      completionsThinkingCompat: {
        thinkingFormat: 'openai',
        supportsReasoningEffort: true,
      },
    };
  }
  return {};
}

function normalizeResolvedBaseUrl(api: Api, baseUrl: string): string {
  return isModelProviderApi(api)
    ? normalizeProviderBaseUrl(api, baseUrl)
    : baseUrl.replace(/\/+$/u, '');
}

function buildResolvedModel(scope: {
  readonly input: FinishResolveInput;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly baseUrl: string;
  readonly thinking: ResolvedThinking;
}): Model<Api> {
  const { input, contextWindow, maxTokens, baseUrl, thinking } = scope;
  const thinkingLevelMap = resolvedThinkingLevelMap(thinking);
  const compat = resolvedModelCompatibility(input, thinking);
  return {
    id: input.modelId,
    name: input.modelId,
    api: input.api,
    provider: input.runtimeProvider ?? input.provider,
    baseUrl,
    reasoning: thinking.enabled,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: deriveModelInput(input.modelRef),
    cost: resolvedModelCost(input),
    contextWindow,
    maxTokens,
    ...(compat ? { compat } : {}),
  };
}

function resolvedThinkingLevelMap(thinking: ResolvedThinking): ThinkingLevelMap | undefined {
  if (thinking.thinkingLevelMap) return thinking.thinkingLevelMap;
  return thinking.maxLevel ? { max: thinking.maxLevel } : undefined;
}

const ZERO_MODEL_COST: Model<Api>['cost'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Token rates for the resolved model, in USD per million tokens.
 *
 * Pi multiplies these rates by the turn's token counts and the Runtime persists
 * the result with every assistant message; that persisted total is what the
 * status line reports as the session cost. A zero rate therefore does not read
 * as "free", it reads as "never priced": the total stays $0 and the item that
 * shows it stays hidden. So a rate the provider declares wins, and a route the
 * account already pays for by plan or by sign-in keeps the zero rate — the Pi
 * catalog lists a per-token price for those models too, and reporting it would
 * invent a charge the account is not billed.
 */
function resolvedModelCost(input: FinishResolveInput): Model<Api>['cost'] {
  const declared = declaredModelCost(input.modelCost);
  if (declared) return declared;
  if (input.managedProvider || (input.byokProvider && !input.customProvider)) {
    return ZERO_MODEL_COST;
  }
  return input.catalogModel?.cost ?? ZERO_MODEL_COST;
}

/**
 * Reads the declared rate out of opaque provider config into Pi's rate shape.
 *
 * Both directions must be a real, finite, non-negative price: a half-declared or
 * negative rate would price a turn at a number nobody published, so it is
 * dropped and the model left unpriceable instead. An explicit zero is honoured
 * as "this endpoint is not billed by the token", which also keeps the Pi
 * catalog's list price for whatever model the endpoint fronts out of the total.
 */
function declaredModelCost(declared: LocalModelConfig['cost']): Model<Api>['cost'] | undefined {
  if (!declared) return undefined;
  const input = tokenRate(declared.input);
  const output = tokenRate(declared.output);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cacheRead: tokenRate(declared.cache_read) ?? 0,
    cacheWrite: tokenRate(declared.cache_write) ?? 0,
  };
}

function tokenRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolvedModelCompatibility(
  input: FinishResolveInput,
  thinking: ResolvedThinking,
): Model<Api>['compat'] | undefined {
  let thinkingCompat: Model<Api>['compat'] | undefined = thinking.completionsThinkingCompat;
  if (
    thinking.forceAdaptiveThinking ||
    (input.api === 'anthropic-messages' && thinking.openPlatform && thinking.enabled)
  ) {
    thinkingCompat = { forceAdaptiveThinking: true };
  }
  const firstPartyMinimaxMessages = isFirstPartyMinimaxMessagesRoute(input.api, input.provider);
  const base = firstPartyMinimaxMessages
    ? { ...thinkingCompat, supportsLongCacheRetention: false }
    : thinkingCompat;
  // Pi applies any field present on `model.compat` ahead of its own provider/baseUrl
  // detection, so a provider config that declares its upstream protocol surface wins
  // over a fingerprint the gateway host has already masked.
  if (!input.modelCompat) return base;
  return { ...base, ...input.modelCompat };
}

function resolveModelStream(
  input: FinishResolveInput,
  streamFn: StreamFn | undefined,
): StreamFn | undefined {
  const dynamicStream = withLocalDynamicMaxTokens(streamFn);
  if (!input.byokProvider) return dynamicStream;
  return withByokErrorAttribution({
    providerId: input.provider,
    ...(dynamicStream ? { streamFn: dynamicStream } : {}),
  });
}

export function lookupLocalModelLimits(
  provider: string,
  modelId: string,
): {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly fromCatalog: boolean;
  readonly api?: Api;
  readonly baseUrl?: string;
} {
  const entry = lookupLocalCatalogModel(provider, modelId);
  if (!entry) return { ...FALLBACK_MODEL_LIMITS, fromCatalog: false };
  return {
    contextWindow: positive(entry.contextWindow) || FALLBACK_MODEL_LIMITS.contextWindow,
    maxTokens: positive(entry.maxTokens) || FALLBACK_MODEL_LIMITS.maxTokens,
    fromCatalog: true,
    ...(entry.api ? { api: entry.api } : {}),
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
  };
}

export function resolveLocalProviderCredentials(
  provider: string,
  modelRef: IModelRef,
  providerConfig?: LocalModelsConfig,
  authContext?: LocalRuntimeAuthContext,
): {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly rawProviderOptions?: LocalProviderOptions;
  readonly authMode: ProviderAuthMode;
  readonly authModeSource: ProviderAuthModeSource;
  readonly managedBaseURL: boolean;
  readonly warnings: string[];
} {
  const options = providerConfig?.[provider]?.options;
  const configuredBaseUrl = modelRef.base_url?.trim() || options?.baseURL?.trim();
  const auth = resolveProviderAuthMode({
    authMode: options?.authMode,
    baseURL: configuredBaseUrl,
  });
  const optionHeaders = readStringRecord(options?.headers);
  const modelHeaders = readStringRecord(
    providerConfig?.[provider]?.models?.[modelRef.model_id?.trim() ?? '']?.headers,
  );
  const token = authContext?.accessToken?.trim();
  const headers = resolveCredentialHeaders(optionHeaders, modelHeaders, token, auth.authMode);
  return {
    apiKey: resolveCredentialApiKey(modelRef, options, auth.authMode),
    baseUrl: resolveCredentialBaseUrl(configuredBaseUrl, auth.managedBaseURL),
    ...(headers ? { headers } : {}),
    ...(options ? { rawProviderOptions: options } : {}),
    authMode: auth.authMode,
    authModeSource: auth.source,
    managedBaseURL: auth.managedBaseURL,
    warnings: auth.warnings,
  };
}

function resolveCredentialApiKey(
  modelRef: IModelRef,
  options: LocalProviderOptions | undefined,
  authMode: ProviderAuthMode,
): string | undefined {
  const configured = modelRef.api_key?.trim() || options?.apiKey?.trim();
  if (configured) return configured;
  return authMode === 'managed-login' ? MANAGED_PROVIDER_API_KEY_PLACEHOLDER : undefined;
}

function providerRouteForAuthMode(authMode: ProviderAuthMode): string {
  if (authMode === 'managed-login') return 'token_plan';
  if (authMode === 'oauth') return 'oauth';
  return 'provider_api_key';
}

function resolveCredentialBaseUrl(
  configuredBaseUrl: string | undefined,
  managedBaseUrl: boolean,
): string | undefined {
  if (!configuredBaseUrl) return undefined;
  return managedBaseUrl ? stripUrlCredentials(configuredBaseUrl) : configuredBaseUrl;
}

function resolveCredentialHeaders(
  optionHeaders: Record<string, string> | undefined,
  modelHeaders: Record<string, string> | undefined,
  token: string | undefined,
  authMode: ProviderAuthMode,
): Record<string, string> | undefined {
  if (!optionHeaders && !modelHeaders && !token) return undefined;
  const managedToken = authMode === 'managed-login' ? token : undefined;
  return {
    ...optionHeaders,
    ...modelHeaders,
    ...(managedToken ? { Authorization: `Bearer ${managedToken}` } : {}),
  };
}

function requireUsableCredentials(
  provider: string,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  credentials: ReturnType<typeof resolveLocalProviderCredentials>,
): { readonly apiKey: string; readonly baseUrl: string; readonly unauthenticatedEndpoint?: true } {
  if (!apiKey) {
    if (credentials.authMode === 'oauth') {
      throw new Error(
        `LocalModelResolver: ${provider} login required; no OAuth credentials found.`,
      );
    }
    if (credentials.authMode !== 'managed-login') {
      // No key on a route that is not a sign-in: the endpoint needs no
      // authentication, so the transport gets the placeholder key and the
      // credential headers are cleared for this request.
      if (!baseUrl) {
        throw new Error(`LocalModelResolver: base_url not configured for provider "${provider}".`);
      }
      return { apiKey: UNAUTHENTICATED_PROVIDER_API_KEY, baseUrl, unauthenticatedEndpoint: true };
    }
    throw new Error(
      provider === OPENAI_CODEX_PROVIDER_ID
        ? 'LocalModelResolver: openai-codex login required; no OAuth credentials found.'
        : `LocalModelResolver: api_key not configured for provider "${provider}".`,
    );
  }
  if (!baseUrl) {
    throw new Error(`LocalModelResolver: base_url not configured for provider "${provider}".`);
  }
  if (credentials.authMode === 'managed-login' && !credentials.managedBaseURL) {
    throw new Error(
      `LocalModelResolver: managed-login requires a known managed base_url for provider "${provider}".`,
    );
  }
  if (
    credentials.authMode === 'managed-login' &&
    apiKey === MANAGED_PROVIDER_API_KEY_PLACEHOLDER &&
    !credentials.headers?.Authorization
  ) {
    throw new Error(
      `LocalModelResolver: managed OAuth bearer is not synced for provider "${provider}".`,
    );
  }
  return { apiKey, baseUrl };
}

function deriveModelInput(modelRef: IModelRef): Model<Api>['input'] {
  return modelRef.capabilities?.support_image || modelRef.capabilities?.support_video
    ? ['text', 'image']
    : ['text'];
}

function lookupLocalCatalogModel(provider: string, modelId: string): Model<Api> | undefined {
  const knownProvider = getProviders().find((candidate) => candidate === provider);
  if (!knownProvider) return undefined;
  return getModels(knownProvider).find((model) => model.id === modelId);
}

function positive(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : 0;
}

// Upstream capability projection preserves number|string; this resolved admission seam requires a positive safe integer.
function normalizeResolvedRequestBodyAdmissionLimit(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

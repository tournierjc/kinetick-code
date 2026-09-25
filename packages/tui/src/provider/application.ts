import type {
  KcodeCopilotOAuthStatus,
  KcodeCodexOAuthStartResult,
  KcodeCodexOAuthLoginOptions,
  KcodeCodexOAuthStatus,
  KcodeCreateProviderInput,
  KcodeMiniMaxModelSource,
  KcodeProviderRuntimePort,
  KcodeSaveProviderCandidateInput,
  KcodeSaveProviderCandidateResult,
  KcodeProviderSnapshot,
  KcodeProviderTestResult,
  KcodeProviderView,
  KcodeRuntimeProviderView,
  KcodeUpdateProviderInput,
} from './contract.js';
import {
  KCODE_COPILOT_PROVIDER_ID,
  KCODE_LOCAL_SETUP,
  KCODE_OPENROUTER_SETUP,
  isModelProviderApiFormat,
  kcodeCustomProviderKey,
} from './contract.js';

export class KcodeProviderApplication {
  constructor(private readonly port: KcodeProviderRuntimePort) {}

  async snapshot(
    options: {
      readonly includeCodexOAuth?: boolean;
      readonly includeCopilotOAuth?: boolean;
    } = {},
  ): Promise<KcodeProviderSnapshot> {
    const [
      providers,
      minimaxStatus,
      minimaxModelSource,
      codexOAuthStatus,
      copilotOAuthStatus,
    ] = await Promise.all([
      this.port.listModelProviders(),
      this.port.getMiniMaxApiKeyStatus(),
      this.port.getMiniMaxModelSource(),
      options.includeCodexOAuth ? this.port.getCodexOAuthStatus() : undefined,
      options.includeCopilotOAuth ? this.port.getCopilotOAuthStatus() : undefined,
    ]);
    // The sign-in row exists so a provider with no entry yet can be reached at
    // all. Once the connector has written one, that entry carries the revision,
    // the model roster and the removal path, so showing both would render one
    // connection twice.
    const copilotConfigured = providers.some(
      (provider) => kcodeCustomProviderKey(provider.providerId) === KCODE_COPILOT_PROVIDER_ID,
    );
    return {
      minimaxModelSource,
      providers: [
        ...(!codexOAuthStatus || codexOAuthStatus.state === 'hidden'
          ? []
          : [normalizeCodexOAuthProvider(codexOAuthStatus)]),
        ...(!copilotConfigured && copilotOAuthStatus && copilotOAuthStatus.state !== 'hidden'
          ? [normalizeCopilotOAuthProvider(copilotOAuthStatus)]
          : []),
        {
          providerId: 'minimax_oauth',
          name: 'MiniMax OAuth',
          kind: 'minimax-oauth',
          active: minimaxModelSource === 'token_plan',
          enabled: true,
          readOnly: true,
          hasApiKey: false,
          models: [],
        },
        {
          providerId: 'minimax_api',
          name: 'MiniMax API Key',
          kind: 'minimax-api-key',
          active: minimaxModelSource === 'minimax_api_key',
          enabled: true,
          readOnly: false,
          hasApiKey: minimaxStatus.hasApiKey,
          ...(minimaxStatus.maskedApiKey ? { maskedApiKey: minimaxStatus.maskedApiKey } : {}),
          ...(minimaxStatus.cachedStatus ? { status: minimaxStatus.cachedStatus } : {}),
          models: [],
        },
        // These rows exist so the two connections the panel sets up itself are
        // visible before anything is saved. A matching connection replaces the
        // row: the saved entry carries the key, URL, revision, and models.
        ...(!providers.some(isOpenRouterConnection) ? [openRouterSetupRow()] : []),
        ...(!providers.some(isLocalConnection) ? [localSetupRow()] : []),
        ...providers.map((provider) => normalizeConfiguredProvider(provider, copilotOAuthStatus)),
      ],
    };
  }

  setMiniMaxSource(source: KcodeMiniMaxModelSource): Promise<KcodeMiniMaxModelSource> {
    return this.port.setMiniMaxModelSource(source);
  }

  connectCodexOAuth(options?: KcodeCodexOAuthLoginOptions): Promise<KcodeCodexOAuthStartResult> {
    return this.port.startCodexOAuthLogin(options);
  }

  getCodexOAuthStatus(): Promise<KcodeCodexOAuthStatus> {
    return this.port.getCodexOAuthStatus();
  }

  cancelCodexOAuthLogin(loginId: string): Promise<KcodeCodexOAuthStatus> {
    return this.port.cancelCodexOAuthLogin(loginId);
  }

  connectCopilotOAuth(): Promise<KcodeCopilotOAuthStatus> {
    return this.port.startCopilotOAuthLogin();
  }

  getCopilotOAuthStatus(): Promise<KcodeCopilotOAuthStatus> {
    return this.port.getCopilotOAuthStatus();
  }

  cancelCopilotOAuthLogin(loginId: string): Promise<KcodeCopilotOAuthStatus> {
    return this.port.cancelCopilotOAuthLogin(loginId);
  }

  async setMiniMaxApiKey(apiKey: string, saveAndUse = true): Promise<void> {
    await this.port.upsertMiniMaxApiKey({ apiKey, saveAndUse });
  }

  async create(input: KcodeCreateProviderInput): Promise<void> {
    await this.port.createUserModelProvider(input);
  }

  saveCandidate(input: KcodeSaveProviderCandidateInput): Promise<KcodeSaveProviderCandidateResult> {
    return this.port.saveUserModelProviderCandidate(input);
  }

  async refreshModels(provider: KcodeProviderView): Promise<number> {
    if (
      provider.kind !== 'custom' ||
      provider.readOnly ||
      !provider.baseUrl ||
      !provider.configRevision
    ) {
      throw new Error('Reopen /provider and select an editable connection.');
    }
    const candidate = {
      providerId: provider.providerId,
      expectedRevision: provider.configRevision,
      baseUrl: provider.baseUrl,
    };
    const discovered = await this.port.discoverUserModelsCandidate(candidate);
    const ids = new Set(provider.models.map(({ modelId }) => modelId));
    const added = discovered
      .map(({ modelId, displayName }) => ({
        modelId: modelId.trim(),
        ...(displayName ? { displayName } : {}),
      }))
      .filter(({ modelId }) => {
        if (!modelId || ids.has(modelId)) return false;
        ids.add(modelId);
        return true;
      });
    const firstAdded = added[0];
    if (!firstAdded) return 0;
    const result = await this.port.saveUserModelProviderCandidate({
      ...candidate,
      // IDs retain every saved model field, including disabled state and limits.
      models: [
        ...provider.models.map(({ modelId }) => ({ modelId })),
        ...added.map((model) => ({ ...model, configurationSource: 'discovered' as const })),
      ],
      modelId: firstAdded.modelId,
      skipConnectionTest: true,
      saveAndUse: false,
    });
    if (!result.success)
      throw new Error(result.status?.lastErrorMessage ?? 'Could not save refreshed models.');
    return added.length;
  }

  async update(input: KcodeUpdateProviderInput): Promise<void> {
    await this.port.updateUserModelProvider(input);
  }

  async remove(providerId: string): Promise<void> {
    await this.port.deleteUserModelProvider(providerId);
  }

  test(providerId: string, modelId?: string): Promise<KcodeProviderTestResult> {
    return modelId
      ? this.port.testUserModel(providerId, modelId)
      : this.port.testUserModelProvider(providerId);
  }
}

function openRouterSetupRow(): KcodeProviderView {
  return {
    providerId: KCODE_OPENROUTER_SETUP.providerId,
    name: KCODE_OPENROUTER_SETUP.name,
    kind: 'openrouter-setup',
    active: false,
    enabled: true,
    readOnly: false,
    apiFormat: KCODE_OPENROUTER_SETUP.apiFormat,
    baseUrl: KCODE_OPENROUTER_SETUP.baseUrl,
    hasApiKey: false,
    models: [],
  };
}

function localSetupRow(): KcodeProviderView {
  return {
    providerId: KCODE_LOCAL_SETUP.providerId,
    name: KCODE_LOCAL_SETUP.name,
    kind: 'local-setup',
    active: false,
    enabled: true,
    readOnly: false,
    apiFormat: KCODE_LOCAL_SETUP.apiFormat,
    baseUrl: KCODE_LOCAL_SETUP.baseUrl,
    hasApiKey: false,
    models: [],
  };
}

/** A saved or builtin connection that already is OpenRouter, so the setup row would duplicate it. */
function isOpenRouterConnection(provider: KcodeRuntimeProviderView): boolean {
  const key = kcodeCustomProviderKey(provider.providerId).trim().toLowerCase();
  if (
    key === KCODE_OPENROUTER_SETUP.providerId ||
    key.startsWith(`${KCODE_OPENROUTER_SETUP.providerId}-`)
  ) {
    return true;
  }
  if (provider.name?.trim().toLowerCase() === KCODE_OPENROUTER_SETUP.name.toLowerCase()) return true;
  const host = providerHostname(provider.baseUrl);
  return host === 'openrouter.ai' || Boolean(host?.endsWith('.openrouter.ai'));
}

/**
 * A saved connection that already is the local OpenAI-compatible server: the
 * catalogue's "Local model" name, a provider key derived from "Local", or any
 * loopback base URL.
 */
function isLocalConnection(provider: KcodeRuntimeProviderView): boolean {
  const key = kcodeCustomProviderKey(provider.providerId).trim().toLowerCase();
  if (key === KCODE_LOCAL_SETUP.providerId || key === 'local-model' || key.startsWith('local-')) {
    return true;
  }
  const name = provider.name?.trim().toLowerCase();
  if (name === 'local' || name === 'local model') return true;
  const host = providerHostname(provider.baseUrl);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function providerHostname(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeCodexOAuthProvider(status: KcodeCodexOAuthStatus): KcodeProviderView {
  return {
    providerId: status.providerId,
    name: 'OpenAI Codex',
    kind: 'codex-oauth',
    active: false,
    enabled: true,
    readOnly: true,
    hasApiKey: false,
    models: [],
    status: {
      state: status.state,
      ...(status.error ? { lastErrorMessage: status.error } : {}),
    },
  };
}

function normalizeCopilotOAuthProvider(status: KcodeCopilotOAuthStatus): KcodeProviderView {
  return {
    providerId: status.providerId,
    name: 'GitHub Copilot',
    kind: 'copilot-oauth',
    active: false,
    enabled: true,
    readOnly: true,
    hasApiKey: false,
    models: [],
    status: {
      state: status.state,
      ...(status.error ? { lastErrorMessage: status.error } : {}),
    },
  };
}

/**
 * A connection the runtime resolves: one of the user's `custom_provider`
 * entries — editable through revision-checked candidate saves — or an entry in
 * the builtin `provider` tree, which `/provider` shows and tests but does not
 * rewrite, because that tree belongs to config.yaml rather than to this panel.
 * Its rows therefore carry no `configRevision`, and `readOnly` states the
 * refusal once instead of leaving `e` to fail on a missing revision.
 */
function normalizeConfiguredProvider(
  provider: KcodeRuntimeProviderView,
  copilotOAuthStatus?: KcodeCopilotOAuthStatus,
): KcodeProviderView {
  const apiFormat = isModelProviderApiFormat(provider.apiFormat) ? provider.apiFormat : undefined;
  // The connector's own entry keeps the Copilot identity, so its row reports and
  // starts the sign-in instead of offering the generic custom-row actions.
  const copilot = kcodeCustomProviderKey(provider.providerId) === KCODE_COPILOT_PROVIDER_ID;
  const builtin = provider.source === 'provider';
  return {
    providerId: provider.providerId,
    name: provider.name?.trim() || provider.providerId,
    kind: copilot ? 'copilot-oauth' : builtin ? 'builtin' : 'custom',
    // A disabled provider is never "in use": Runtime drops it from the model
    // roster (`enabledCustomProviders`) and BYOK resolution refuses it, so a
    // leftover `selected` model must not render as the active source.
    active: Boolean(
      provider.enabled !== false &&
      provider.models?.some((model) => 'selected' in model && model.selected),
    ),
    enabled: provider.enabled !== false,
    readOnly: builtin || provider.kind === 'oauth',
    ...(provider.configRevision ? { configRevision: provider.configRevision } : {}),
    ...(apiFormat ? { apiFormat } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    hasApiKey: Boolean(provider.hasApiKey),
    ...(provider.maskedApiKey ? { maskedApiKey: provider.maskedApiKey } : {}),
    models: (provider.models ?? []).map((model) => ({
      modelId: model.modelId,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.selected !== undefined ? { selected: model.selected } : {}),
      ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.status ? { status: model.status } : {}),
    })),
    ...(copilot && copilotOAuthStatus
      ? {
          status: {
            state: copilotOAuthStatus.state,
            ...(copilotOAuthStatus.error ? { lastErrorMessage: copilotOAuthStatus.error } : {}),
          },
        }
      : provider.status
        ? { status: provider.status }
        : {}),
  };
}

export type {
  KcodeCreateProviderInput,
  KcodeProviderRuntimePort,
  KcodeProviderSnapshot,
  KcodeUpdateProviderInput,
} from './contract.js';

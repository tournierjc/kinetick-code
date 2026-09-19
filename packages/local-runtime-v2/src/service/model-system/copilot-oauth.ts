import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { resolveBetaFeature } from '@mavis/config';

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalCustomProvidersConfig,
  LocalModelConfig,
  LocalRuntimeConfig,
} from './contracts.js';
import {
  COPILOT_API_BASE_URL,
  CopilotModelDiscoveryClient,
  copilotBaseUrlFromToken,
  type CopilotModelCatalog,
  type CopilotModelCredentials,
} from './connectivity/copilot-model-discovery.js';
import { GITHUB_COPILOT_PROVIDER_ID } from './identity.js';

export { GITHUB_COPILOT_PROVIDER_ID } from './identity.js';

/**
 * Pi keeps every provider's credentials — OAuth and plain keys — in one
 * profile-scoped AuthStorage file, and the runtime's `providerAuthGetter` reads
 * that file by provider id. Copilot therefore shares the existing store rather
 * than adding a second one.
 */
export const PROVIDER_CREDENTIALS_FILE = 'codex-auth.json';

/** Environment tokens accepted as a Copilot credential when no sign-in is stored. */
const COPILOT_TOKEN_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type CopilotOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

/** `oauth` is a signed-in account; `token` is a supplied GitHub token. */
export type CopilotCredentialSource = 'oauth' | 'token';

export interface CopilotOAuthDeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
}

export interface CopilotOAuthStatus {
  readonly state: CopilotOAuthState;
  readonly providerId: typeof GITHUB_COPILOT_PROVIDER_ID;
  readonly error?: string;
  readonly loginId?: string;
  readonly credentialSource?: CopilotCredentialSource;
  readonly deviceCode?: CopilotOAuthDeviceCode;
  /**
   * Models the account catalog lists but that GitHub answers with
   * `model_not_supported` until the account accepts their terms.
   */
  readonly policyOptInRequired?: readonly string[];
}

interface CopilotCredentials {
  readonly token: string;
  readonly source: CopilotCredentialSource;
  /** Account proxy endpoint derived from an exchanged token, when it names one. */
  readonly baseUrl?: string;
}

type LoginAttempt = {
  readonly id: string;
  readonly controller: AbortController;
  readonly started: Promise<CopilotOAuthStatus>;
  readonly resolve: (status: CopilotOAuthStatus) => void;
  readonly reject: (error: Error) => void;
  status?: CopilotOAuthStatus;
  timeout?: ReturnType<typeof setTimeout>;
};

interface CopilotAuthStorage {
  credentialType(provider: string): 'oauth' | 'api_key' | undefined;
  getToken(provider: string): Promise<string | undefined>;
  storeToken(provider: string, token: string): void;
  remove(provider: string): void;
  login(provider: string, callbacks: Parameters<AuthStorage['login']>[1]): Promise<void>;
}

export interface CopilotOAuthManagerDeps {
  readonly configGetter: () => LocalRuntimeConfig;
  readonly fetchImpl?: typeof fetch;
  readonly updateByokConfig?: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  readonly authStorageFactory?: (authPath: string) => CopilotAuthStorage;
  readonly catalogGetter?: (
    credentials: CopilotModelCredentials,
  ) => Promise<CopilotModelCatalog>;
}

export class CopilotOAuthError extends Error {
  override name = 'CopilotOAuthError';

  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Owns the GitHub Copilot connector: provider credentials, the account's live
 * model catalog, and the provider entry the resolver reads.
 *
 * Sign-in is the GitHub device flow pi's Copilot OAuth provider already
 * implements; the resulting Copilot token is refreshed by pi on demand. A
 * GitHub token supplied out of band (config or environment) is stored in the
 * same credential store, so both paths resolve through `providerAuthGetter` and
 * keep the model online under the `github-copilot` provider id that pi's
 * transports attribute requests by.
 */
export class CopilotOAuthManager {
  private readonly authStorageFactory: (authPath: string) => CopilotAuthStorage;
  private readonly catalogGetter: (credentials: CopilotModelCredentials) => Promise<CopilotModelCatalog>;
  private pendingCatalog: Promise<void> | undefined;
  private credentialGeneration = 0;
  private login: LoginAttempt | undefined;
  private lastError: string | undefined;
  private policyOptInRequired: readonly string[] = [];

  constructor(private readonly deps: CopilotOAuthManagerDeps) {
    this.authStorageFactory = deps.authStorageFactory ?? defaultAuthStorageFactory;
    this.catalogGetter =
      deps.catalogGetter ??
      ((credentials) => new CopilotModelDiscoveryClient(deps.fetchImpl).discover(credentials));
  }

  getStatus(): CopilotOAuthStatus {
    if (!this.enabled()) return this.status('hidden');
    if (this.login) return this.loginStatus(this.login);
    if (!this.hasConfiguredProvider()) {
      return this.lastError ? this.status('failed', this.lastError) : this.status('disconnected');
    }
    const storage = this.authStorage();
    const source = this.credentialSource(storage);
    if (!source) {
      return this.lastError ? this.status('failed', this.lastError) : this.status('disconnected');
    }
    return this.status('connected', this.lastError, source);
  }

  /** Sign in through the GitHub device flow. */
  async startLogin(): Promise<CopilotOAuthStatus> {
    if (!this.enabled()) {
      throw new CopilotOAuthError(404, 'GitHub Copilot is not enabled.', 'FEATURE_DISABLED');
    }
    if (this.login) return this.login.started;
    const storage = this.authStorage();
    const existing = this.credentialSource(storage);
    if (existing) {
      if (!this.hasConfiguredProvider()) await this.ensureProviderConfigured();
      this.lastError = undefined;
      return this.getStatus();
    }
    this.lastError = undefined;
    const attempt = this.createLoginAttempt();
    this.login = attempt;
    this.setLoginTimeout(attempt, LOGIN_TIMEOUT_MS);
    const completion = this.finishLogin(storage, attempt);
    return Promise.race([attempt.started, completion]);
  }

  cancelLogin(loginId: string): CopilotOAuthStatus {
    const attempt = this.login;
    if (!attempt || attempt.id !== loginId) return this.getStatus();
    this.login = undefined;
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
    clearTimeout(attempt.timeout);
    const error = new CopilotOAuthError(409, 'Copilot sign-in was cancelled.', 'OAUTH_LOGIN_CANCELLED');
    attempt.controller.abort(error);
    attempt.reject(error);
    return this.getStatus();
  }

  /**
   * Store a GitHub token as this connector's credential.
   *
   * Used when the account token is supplied out of band (CI, a shared profile)
   * instead of through the device flow. The token is written to the credential
   * store, never to `config.yaml`.
   */
  async connectWithToken(token: string): Promise<CopilotOAuthStatus> {
    if (!this.enabled()) {
      throw new CopilotOAuthError(404, 'GitHub Copilot is not enabled.', 'FEATURE_DISABLED');
    }
    const trimmed = token.trim();
    if (!trimmed) {
      throw new CopilotOAuthError(400, 'A GitHub token is required.', 'OAUTH_TOKEN_REQUIRED');
    }
    if (this.login) this.cancelLogin(this.login.id);
    this.authStorage().storeToken(GITHUB_COPILOT_PROVIDER_ID, trimmed);
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
    return this.syncCatalog(true);
  }

  /** Re-read the account catalog and rewrite the provider's model entries. */
  async refreshModels(): Promise<CopilotOAuthStatus> {
    return this.syncCatalog(false);
  }

  private async syncCatalog(createIfMissing: boolean): Promise<CopilotOAuthStatus> {
    if (!this.enabled()) {
      throw new CopilotOAuthError(404, 'GitHub Copilot is not enabled.', 'FEATURE_DISABLED');
    }
    if (this.login) {
      throw new CopilotOAuthError(
        409,
        'Cancel the current Copilot sign-in before fetching models.',
        'OAUTH_LOGIN_PENDING',
      );
    }
    if (!this.credentialSource(this.authStorage())) {
      throw new CopilotOAuthError(
        409,
        'Connect GitHub Copilot before fetching models.',
        'OAUTH_NOT_CONNECTED',
      );
    }
    const generation = this.credentialGeneration;
    try {
      await this.ensureProviderConfigured(createIfMissing);
      if (generation === this.credentialGeneration) this.lastError = undefined;
      return this.getStatus();
    } catch (error) {
      const message = copilotOAuthErrorMessage(error);
      if (generation === this.credentialGeneration) this.lastError = message;
      if (error instanceof CopilotOAuthError) throw error;
      throw new CopilotOAuthError(502, message, 'MODEL_DISCOVERY_FAILED');
    }
  }

  removeCredentials(providerId: string): void {
    if (providerId !== GITHUB_COPILOT_PROVIDER_ID) {
      throw new CopilotOAuthError(
        404,
        `OAuth credential storage does not support provider ${providerId}.`,
        'PROVIDER_AUTH_UNAVAILABLE',
      );
    }
    if (this.login) this.cancelLogin(this.login.id);
    this.authStorage().remove(GITHUB_COPILOT_PROVIDER_ID);
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
  }

  private enabled(): boolean {
    return resolveBetaFeature('copilotOAuth', this.deps.configGetter().beta?.copilotOAuth, {
      internalBuild: process.env.__MAVIS_BUILD_INTERNAL === 'true',
    });
  }

  private authStorage(): CopilotAuthStorage {
    return this.authStorageFactory(
      join(this.deps.configGetter().dataDir, PROVIDER_CREDENTIALS_FILE),
    );
  }

  private credentialSource(storage: CopilotAuthStorage): CopilotCredentialSource | undefined {
    const type = storage.credentialType(GITHUB_COPILOT_PROVIDER_ID);
    if (type === 'oauth') return 'oauth';
    if (type === 'api_key') return 'token';
    return this.configuredToken() ? 'token' : undefined;
  }

  private configuredToken(): string | undefined {
    for (const name of COPILOT_TOKEN_ENV_VARS) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private hasConfiguredProvider(): boolean {
    const provider = this.copilotProvider();
    return Object.keys(provider?.models ?? {}).length > 0;
  }

  private copilotProvider(): LocalCustomProviderConfig | undefined {
    const config = this.deps.configGetter();
    return config.custom_provider?.[GITHUB_COPILOT_PROVIDER_ID] ?? config.provider?.[GITHUB_COPILOT_PROVIDER_ID];
  }

  private status(
    state: CopilotOAuthState,
    error?: string,
    credentialSource?: CopilotCredentialSource,
  ): CopilotOAuthStatus {
    return {
      state,
      providerId: GITHUB_COPILOT_PROVIDER_ID,
      ...(error ? { error } : {}),
      ...(credentialSource ? { credentialSource } : {}),
      ...(this.policyOptInRequired.length > 0
        ? { policyOptInRequired: this.policyOptInRequired }
        : {}),
    };
  }

  private createLoginAttempt(): LoginAttempt {
    let resolve!: LoginAttempt['resolve'];
    let reject!: LoginAttempt['reject'];
    const started = new Promise<CopilotOAuthStatus>((resolveStart, rejectStart) => {
      resolve = resolveStart;
      reject = rejectStart;
    });
    return { id: randomUUID(), controller: new AbortController(), started, resolve, reject };
  }

  private loginStatus(attempt: LoginAttempt): CopilotOAuthStatus {
    return attempt.status ?? { ...this.status('pending'), loginId: attempt.id };
  }

  private setLoginTimeout(attempt: LoginAttempt, timeoutMs: number): void {
    clearTimeout(attempt.timeout);
    attempt.timeout = setTimeout(() => {
      if (this.login !== attempt) return;
      const error = new CopilotOAuthError(
        408,
        'Copilot sign-in timed out. Start login again.',
        'OAUTH_LOGIN_EXPIRED',
      );
      this.login = undefined;
      this.credentialGeneration += 1;
      this.pendingCatalog = undefined;
      this.lastError = error.message;
      attempt.controller.abort(error);
      attempt.reject(error);
    }, timeoutMs);
    attempt.timeout.unref?.();
  }

  private loginCallbacks(attempt: LoginAttempt): Parameters<AuthStorage['login']>[1] {
    const { signal } = attempt.controller;
    const settle = (details: Partial<CopilotOAuthStatus>) => {
      signal.throwIfAborted();
      if (attempt.status) return;
      attempt.status = { ...this.loginStatus(attempt), ...details };
      attempt.resolve(attempt.status);
    };
    return {
      onAuth: () => {
        // The device flow never opens a browser callback; a URL here would mean pi changed protocol.
        throw new CopilotOAuthError(
          502,
          'Copilot sign-in returned an unexpected callback URL.',
          'OAUTH_START_FAILED',
        );
      },
      onDeviceCode: ({ userCode, verificationUri, expiresInSeconds = 900 }) => {
        if (!userCode || !verificationUri || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
          throw new CopilotOAuthError(
            502,
            'Copilot sign-in returned invalid device-code details.',
            'OAUTH_START_FAILED',
          );
        }
        this.setLoginTimeout(attempt, expiresInSeconds * 1000);
        settle({
          deviceCode: {
            userCode,
            verificationUri,
            expiresAt: Date.now() + expiresInSeconds * 1000,
          },
        });
      },
      // A blank answer keeps the default host; enterprise accounts pass their own domain.
      onPrompt: async () => '',
      onSelect: async () => 'github-copilot',
      onManualCodeInput: () => Promise.reject(signal.reason),
      signal,
      fetch: async (input, init) => {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
          ...(init?.signal ? [init.signal] : []),
        ]);
        return (this.deps.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: requestSignal });
      },
    };
  }

  private async finishLogin(
    storage: CopilotAuthStorage,
    attempt: LoginAttempt,
  ): Promise<CopilotOAuthStatus> {
    try {
      await storage.login(GITHUB_COPILOT_PROVIDER_ID, this.loginCallbacks(attempt));
      attempt.controller.signal.throwIfAborted();
      await this.ensureProviderConfigured();
      attempt.controller.signal.throwIfAborted();
      if (this.login !== attempt) return this.getStatus();
      this.lastError = undefined;
      this.login = undefined;
      const connected = this.getStatus();
      attempt.resolve(connected);
      return connected;
    } catch (error) {
      if (this.login !== attempt) return this.getStatus();
      const cause: unknown = attempt.controller.signal.reason ?? error;
      this.lastError = copilotOAuthErrorMessage(cause);
      this.login = undefined;
      const failure =
        cause instanceof CopilotOAuthError
          ? cause
          : new CopilotOAuthError(502, this.lastError, 'OAUTH_LOGIN_FAILED');
      attempt.reject(failure);
      throw failure;
    } finally {
      clearTimeout(attempt.timeout);
    }
  }

  private async ensureProviderConfigured(createIfMissing = true): Promise<void> {
    if (this.pendingCatalog) return this.pendingCatalog;
    const operation = this.refreshProviderCatalog(createIfMissing);
    this.pendingCatalog = operation;
    try {
      await operation;
    } finally {
      if (this.pendingCatalog === operation) this.pendingCatalog = undefined;
    }
  }

  private async refreshProviderCatalog(createIfMissing: boolean): Promise<void> {
    const updater = this.deps.updateByokConfig;
    if (!updater) {
      throw new CopilotOAuthError(
        503,
        'GitHub Copilot provider configuration is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const credentials = await this.resolveCredentials();
    if (!credentials) {
      throw new CopilotOAuthError(
        401,
        'Copilot credentials are unavailable. Connect GitHub Copilot to retry.',
        'OAUTH_CREDENTIALS_UNAVAILABLE',
      );
    }
    // The resolver reads credentials back through `providerAuthGetter`, so a token
    // supplied out of band is persisted to the credential store rather than copied
    // into `config.yaml`.
    if (!this.authStorage().credentialType(GITHUB_COPILOT_PROVIDER_ID)) {
      this.authStorage().storeToken(GITHUB_COPILOT_PROVIDER_ID, credentials.token);
    }
    const discoveryCredentials: CopilotModelCredentials = {
      token: credentials.token,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    };
    const generation = this.credentialGeneration;
    let catalog: CopilotModelCatalog;
    try {
      catalog = await this.catalogGetter(discoveryCredentials);
    } catch (error) {
      if (error instanceof CopilotOAuthError) throw error;
      throw new CopilotOAuthError(
        502,
        'Copilot model discovery failed. Retry fetching models from model settings.',
        'MODEL_DISCOVERY_FAILED',
      );
    }
    if (!createIfMissing && !this.hasConfiguredProvider()) return;
    let configured = false;
    await updater((draft, currentConfig) => {
      if (generation !== this.credentialGeneration) return;
      configureCopilotProvider(draft, currentConfig, catalog.provider, credentials.baseUrl);
      configured = true;
    });
    if (!configured) return;
    if (generation === this.credentialGeneration) {
      this.policyOptInRequired = catalog.policyOptInRequired;
    }
  }

  private async resolveCredentials(): Promise<CopilotCredentials | undefined> {
    const storage = this.authStorage();
    const type = storage.credentialType(GITHUB_COPILOT_PROVIDER_ID);
    if (type) {
      const stored = (await storage.getToken(GITHUB_COPILOT_PROVIDER_ID))?.trim();
      // A stored credential that cannot be read is a failure, not a reason to fall back.
      if (!stored) return undefined;
      const baseUrl = copilotBaseUrlFromToken(stored);
      return {
        token: stored,
        source: type === 'oauth' ? 'oauth' : 'token',
        ...(baseUrl ? { baseUrl } : {}),
      };
    }
    const token = this.configuredToken();
    if (!token) return undefined;
    const baseUrl = copilotBaseUrlFromToken(token);
    return { token, source: 'token', ...(baseUrl ? { baseUrl } : {}) };
  }
}

function defaultAuthStorageFactory(authPath: string): CopilotAuthStorage {
  const storage = AuthStorage.create(authPath);
  return {
    credentialType: (provider) => storage.getAll()[provider]?.type,
    getToken: async (provider) =>
      (await storage.getApiKey(provider, { includeFallback: false }))?.trim() || undefined,
    storeToken: (provider, token) => {
      storage.set(provider, { type: 'api_key', key: token });
    },
    remove: (provider) => {
      storage.logout(provider);
    },
    login: async (provider, callbacks) => {
      // Keep a late token response from a cancelled attempt out of profile storage.
      const pending = AuthStorage.inMemory();
      await pending.login(provider, callbacks);
      callbacks.signal?.throwIfAborted();
      const credentials = pending.getAll()[provider];
      if (!credentials) throw new Error('Copilot credentials are unavailable.');
      storage.set(provider, credentials);
    },
  };
}

function configureCopilotProvider(
  draft: LocalByokConfigDraft,
  currentConfig: LocalRuntimeConfig,
  catalog: LocalCustomProviderConfig,
  baseUrl: string | undefined,
): void {
  const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
  const current =
    currentConfig.custom_provider?.[GITHUB_COPILOT_PROVIDER_ID] ??
    currentConfig.provider?.[GITHUB_COPILOT_PROVIDER_ID];
  tree[GITHUB_COPILOT_PROVIDER_ID] = mergeCopilotProvider(current, catalog, baseUrl);
  draft.custom_provider = tree as Record<string, unknown>;
  if (draft.defaultModel?.startsWith(`${GITHUB_COPILOT_PROVIDER_ID}/`)) {
    draft.defaultModel = `custom_provider:${draft.defaultModel}`;
  }
}

/**
 * The credential is never copied into the provider entry: it stays in the
 * credential store and is read back through `providerAuthGetter` at request time.
 */
function mergeCopilotProvider(
  current: LocalCustomProviderConfig | undefined,
  catalog: LocalCustomProviderConfig,
  baseUrl: string | undefined,
): LocalCustomProviderConfig {
  const currentOptions = { ...(current?.options ?? {}) };
  delete currentOptions.apiKey;
  return {
    ...current,
    api: current?.api ?? catalog.api,
    name: current?.name ?? catalog.name,
    kind: 'oauth',
    enabled: current?.enabled ?? true,
    options: {
      ...catalog.options,
      ...currentOptions,
      baseURL: baseUrl ?? current?.options?.baseURL ?? catalog.options?.baseURL ?? COPILOT_API_BASE_URL,
      authMode: 'oauth',
    },
    models: mergeCopilotModels(current?.models ?? {}, catalog.models ?? {}),
  };
}

function mergeCopilotModels(
  current: Record<string, LocalModelConfig>,
  discovered: Record<string, LocalModelConfig>,
): Record<string, LocalModelConfig> {
  // Stored fields are authoritative, including an edited context limit or effort
  // override: a refresh replaces catalog values, not user decisions.
  const models = new Map(Object.entries(current));
  for (const [id, model] of Object.entries(discovered)) {
    const existing = models.get(id);
    models.set(id, {
      ...model,
      ...existing,
      ...(model.limit || existing?.limit ? { limit: { ...model.limit, ...existing?.limit } } : {}),
      ...(model.modalities || existing?.modalities
        ? { modalities: { ...model.modalities, ...existing?.modalities } }
        : {}),
      ...(model.thinking || existing?.thinking
        ? { thinking: { ...model.thinking, ...existing?.thinking } }
        : {}),
      ...(model.provider || existing?.provider
        ? { provider: { ...model.provider, ...existing?.provider } }
        : {}),
    });
  }
  return Object.fromEntries(models);
}

function copilotOAuthErrorMessage(error: unknown): string {
  if (error instanceof CopilotOAuthError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Device flow timed out')) return 'Device code expired. Start sign-in again.';
  if (message.includes('Login cancelled')) return 'Copilot sign-in was cancelled.';
  if (message.includes('device code login is not enabled')) {
    return 'Enable device code login for your GitHub account, then retry.';
  }
  if (/Copilot model discovery failed/u.test(message)) return message;
  return 'Copilot sign-in failed.';
}

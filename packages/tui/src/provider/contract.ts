import type { ModelConfig } from '@mavis/config';

export const KCODE_PROVIDER_API_FORMATS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
] as const;
export type KcodeProviderApiFormat = (typeof KCODE_PROVIDER_API_FORMATS)[number];

const KCODE_PROVIDER_API_FORMAT_SET = new Set<string>(KCODE_PROVIDER_API_FORMATS);

export function isModelProviderApiFormat(value: unknown): value is KcodeProviderApiFormat {
  return typeof value === 'string' && KCODE_PROVIDER_API_FORMAT_SET.has(value);
}
export type KcodeMiniMaxModelSource = 'token_plan' | 'minimax_api_key';
export type KcodeProviderKind =
  | 'codex-oauth'
  | 'copilot-oauth'
  | 'minimax-oauth'
  | 'minimax-api-key'
  | 'custom';

/** Provider key the GitHub Copilot connector writes into `custom_provider`. */
export const KCODE_COPILOT_PROVIDER_ID = 'github-copilot';

/**
 * Runtime prefixes the id of every configured provider, so the id a snapshot
 * receives is not the key the connector writes. Mirrors `CUSTOM_PROVIDER_ID_PREFIX`
 * in the model system's `resolution/model-key.ts`.
 */
const KCODE_CUSTOM_PROVIDER_ID_PREFIX = 'custom_provider:';

/** Reduces a runtime provider id to the key the connector keeps credentials under. */
export function kcodeCustomProviderKey(providerId: string): string {
  return providerId.startsWith(KCODE_CUSTOM_PROVIDER_ID_PREFIX)
    ? providerId.slice(KCODE_CUSTOM_PROVIDER_ID_PREFIX.length)
    : providerId;
}

export interface KcodeProviderStatus {
  readonly state: string;
  readonly lastTestedAt?: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

export interface KcodeProviderModel {
  readonly modelId: string;
  readonly displayName?: string;
  readonly selected?: boolean;
  readonly contextLimit?: number;
  readonly maxOutputTokens?: number;
  readonly status?: KcodeProviderStatus;
}

export interface KcodeRuntimeProviderView {
  readonly providerId: string;
  readonly name?: string;
  readonly kind?: string;
  readonly enabled?: boolean;
  readonly apiFormat?: string;
  readonly baseUrl?: string;
  readonly hasApiKey?: boolean;
  readonly maskedApiKey?: string;
  readonly rawApiKey?: string;
  readonly configRevision?: string;
  readonly models?: readonly KcodeProviderModel[];
  readonly status?: KcodeProviderStatus;
}

export interface KcodeProviderView {
  readonly providerId: string;
  readonly name: string;
  readonly kind: KcodeProviderKind;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly configRevision?: string;
  readonly apiFormat?: KcodeProviderApiFormat;
  readonly baseUrl?: string;
  readonly hasApiKey: boolean;
  readonly maskedApiKey?: string;
  readonly models: readonly KcodeProviderModel[];
  readonly status?: KcodeProviderStatus;
}

export interface KcodeProviderSnapshot {
  readonly minimaxModelSource: KcodeMiniMaxModelSource;
  readonly providers: readonly KcodeProviderView[];
}

export interface KcodeProviderModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly configurationSource?: 'manual' | 'discovered';
  readonly enabled?: boolean;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly temperature?: boolean;
  readonly capabilities?: Readonly<NonNullable<ModelConfig['capabilities']>>;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly limit?: { readonly context?: number; readonly output?: number };
}

export interface KcodeProviderTemplate {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiFormat: KcodeProviderApiFormat;
  readonly models: readonly KcodeProviderModelInput[];
}

export type KcodeCodexOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export type KcodeCodexOAuthLoginMethod = 'browser' | 'device_code';
export interface KcodeCodexOAuthLoginOptions {
  readonly method?: KcodeCodexOAuthLoginMethod;
}
export interface KcodeCodexOAuthStatus {
  readonly state: KcodeCodexOAuthState;
  readonly providerId: 'openai-codex';
  readonly error?: string;
  readonly loginId?: string;
  readonly method?: KcodeCodexOAuthLoginMethod;
  readonly authUrl?: string;
  readonly deviceCode?: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: number;
  };
}

export interface KcodeCodexOAuthStartResult extends KcodeCodexOAuthStatus {
  readonly authUrl?: string;
}

export type KcodeCopilotOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

/**
 * GitHub Copilot sign-in is device-code only, so the status carries the code the
 * account has to enter and nothing to redirect a browser callback to.
 */
export interface KcodeCopilotOAuthStatus {
  readonly state: KcodeCopilotOAuthState;
  readonly providerId: 'github-copilot';
  readonly error?: string;
  readonly loginId?: string;
  readonly deviceCode?: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: number;
  };
  /** Models GitHub refuses until the account accepts their terms. */
  readonly policyOptInRequired?: readonly string[];
}

export interface KcodeCreateProviderInput {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiFormat: KcodeProviderApiFormat;
  readonly models: readonly KcodeProviderModelInput[];
  readonly saveAndUse?: boolean;
}

export interface KcodeUpdateProviderInput {
  readonly providerId: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiFormat?: KcodeProviderApiFormat;
  readonly enabled?: boolean;
  readonly models?: readonly KcodeProviderModelInput[];
  readonly saveAndUse?: boolean;
}

export interface KcodeSaveProviderCandidateInput extends Omit<
  KcodeCreateProviderInput,
  'apiKey' | 'apiFormat' | 'models'
> {
  readonly providerId?: string;
  readonly expectedRevision?: string;
  readonly apiKey?: string;
  readonly apiFormat?: KcodeProviderApiFormat;
  readonly models?: readonly KcodeProviderModelInput[];
  readonly modelId: string;
  readonly skipConnectionTest?: boolean;
}

export interface KcodeDiscoverProviderModelsInput {
  readonly providerId: string;
  readonly expectedRevision: string;
  readonly baseUrl: string;
}

export interface KcodeSaveProviderCandidateResult {
  readonly success: boolean;
  readonly status?: KcodeProviderStatus;
  readonly provider?: KcodeRuntimeProviderView;
}

export interface KcodeProviderTestResult {
  readonly success: boolean;
  readonly status: KcodeProviderStatus;
}

export interface KcodeProviderRuntimePort {
  discoverUserModelsCandidate(
    input: KcodeDiscoverProviderModelsInput,
  ): Promise<readonly KcodeProviderModel[]>;
  listProviderPresets(): Promise<readonly KcodeProviderTemplate[]>;
  getCodexOAuthStatus(): Promise<KcodeCodexOAuthStatus>;
  startCodexOAuthLogin(options?: KcodeCodexOAuthLoginOptions): Promise<KcodeCodexOAuthStartResult>;
  cancelCodexOAuthLogin(loginId: string): Promise<KcodeCodexOAuthStatus>;
  getCopilotOAuthStatus(): Promise<KcodeCopilotOAuthStatus>;
  startCopilotOAuthLogin(): Promise<KcodeCopilotOAuthStatus>;
  cancelCopilotOAuthLogin(loginId: string): Promise<KcodeCopilotOAuthStatus>;
  listUserModelProviders(): Promise<readonly KcodeRuntimeProviderView[]>;
  getMiniMaxApiKeyStatus(): Promise<{
    readonly hasApiKey: boolean;
    readonly maskedApiKey?: string;
    readonly rawApiKey?: string;
    readonly cachedStatus?: KcodeProviderStatus;
  }>;
  getMiniMaxModelSource(): Promise<KcodeMiniMaxModelSource>;
  setMiniMaxModelSource(source: KcodeMiniMaxModelSource): Promise<KcodeMiniMaxModelSource>;
  upsertMiniMaxApiKey(input: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<void>;
  createUserModelProvider(input: KcodeCreateProviderInput): Promise<void>;
  saveUserModelProviderCandidate(
    input: KcodeSaveProviderCandidateInput,
  ): Promise<KcodeSaveProviderCandidateResult>;
  updateUserModelProvider(input: KcodeUpdateProviderInput): Promise<void>;
  deleteUserModelProvider(providerId: string): Promise<void>;
  testUserModelProvider(providerId: string): Promise<KcodeProviderTestResult>;
  testUserModel(providerId: string, modelId: string): Promise<KcodeProviderTestResult>;
}

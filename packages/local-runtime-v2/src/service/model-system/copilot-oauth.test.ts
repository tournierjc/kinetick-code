import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalRuntimeConfig,
} from './contracts.js';
import { CopilotOAuthError, CopilotOAuthManager } from './copilot-oauth.js';
import type { CopilotModelCatalog } from './connectivity/copilot-model-discovery.js';

function createConfig(enabled: boolean): LocalRuntimeConfig {
  return {
    dataDir: '/tmp/model-system-copilot-oauth-test',
    provider: {},
    beta: { copilotOAuth: enabled },
  };
}

function createUpdater(target: LocalRuntimeConfig) {
  return vi.fn(
    async (
      mutate: (
        draft: LocalByokConfigDraft,
        currentConfig: LocalRuntimeConfig,
      ) => void | Promise<void>,
    ) => {
      const draft: LocalByokConfigDraft = {
        custom_provider: target.custom_provider ? structuredClone(target.custom_provider) : undefined,
        defaultModel: target.defaultModel,
      };
      await mutate(draft, target);
      target.custom_provider = draft.custom_provider as LocalRuntimeConfig['custom_provider'];
      target.defaultModel = draft.defaultModel;
      return { config: target };
    },
  );
}

function createCatalog(): CopilotModelCatalog {
  return {
    provider: {
      api: 'openai-completions',
      name: 'GitHub Copilot',
      kind: 'oauth',
      enabled: true,
      options: {
        authMode: 'oauth',
        baseURL: 'https://api.githubcopilot.com',
        headers: { 'Copilot-Integration-Id': 'vscode-chat' },
      },
      models: {
        'gpt-5.4': {
          name: 'GPT-5.4',
          reasoning: true,
          tool_call: true,
          limit: { context: 272000, output: 128000 },
          thinking: { effortOptions: ['none', 'low', 'medium', 'high', 'xhigh'] },
          provider: { api: 'openai-responses' },
        },
        'minimax-m2': {
          name: 'MiniMax M2',
          reasoning: false,
          tool_call: true,
          limit: { context: 200000, output: 64000 },
          provider: { api: 'openai-completions' },
        },
      },
    },
    policyOptInRequired: ['claude-opus-4.8'],
  };
}

/** Auth storage double: `login` reports a device code the way pi's Copilot provider does. */
function createAuthStorage(initial: { type: 'oauth' | 'api_key' } | undefined = undefined) {
  let credential = initial;
  return {
    credentialType: () => credential?.type,
    getToken: async () => (credential ? 'stored-copilot-token' : undefined),
    storeToken: vi.fn((_provider: string, _token: string) => {
      credential = { type: 'api_key' };
    }),
    remove: vi.fn(() => {
      credential = undefined;
    }),
    login: vi.fn(async (_provider: string, callbacks: Parameters<AuthStorage['login']>[1]) => {
      callbacks.onDeviceCode({
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      credential = { type: 'oauth' };
    }),
  };
}

function managerFor(options: {
  config?: LocalRuntimeConfig;
  authStorage?: ReturnType<typeof createAuthStorage>;
  catalog?: CopilotModelCatalog;
}) {
  const config = options.config ?? createConfig(true);
  const authStorage = options.authStorage ?? createAuthStorage();
  const updater = createUpdater(config);
  const manager = new CopilotOAuthManager({
    configGetter: () => config,
    authStorageFactory: () => authStorage,
    updateByokConfig: updater,
    catalogGetter: async () => options.catalog ?? createCatalog(),
  });
  return { manager, config, authStorage, updater };
}

describe('CopilotOAuthManager', () => {
  it('keeps the connector hidden and rejects sign-in while the feature is off', async () => {
    const { manager } = managerFor({ config: createConfig(false) });

    expect(manager.getStatus()).toEqual({ state: 'hidden', providerId: 'github-copilot' });
    await expect(manager.startLogin()).rejects.toThrow('GitHub Copilot is not enabled.');
  });

  it('reports the device code the account has to enter', async () => {
    const { manager } = managerFor({});

    const status = await manager.startLogin();

    expect(status.state).toBe('pending');
    expect(status.loginId).toBeTruthy();
    expect(status.deviceCode).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    });
  });

  it('cancels a pending sign-in', async () => {
    const { manager } = managerFor({});
    const status = await manager.startLogin();

    const cancelled = manager.cancelLogin(status.loginId ?? '');

    expect(cancelled.state).toBe('disconnected');
  });

  it('stores a supplied token in the credential store and writes the provider entry', async () => {
    const { manager, config, authStorage } = managerFor({});

    const status = await manager.connectWithToken('gho_supplied_token');

    expect(authStorage.storeToken).toHaveBeenCalledWith('github-copilot', 'gho_supplied_token');
    expect(status.state).toBe('connected');
    expect(status.credentialSource).toBe('token');
    const provider = config.custom_provider?.['github-copilot'];
    expect(provider?.kind).toBe('oauth');
    expect(provider?.options?.authMode).toBe('oauth');
    expect(provider?.options?.baseURL).toBe('https://api.githubcopilot.com');
    // The credential is never copied into the provider tree.
    expect(provider?.options?.apiKey).toBeUndefined();
    expect(Object.keys(provider?.models ?? {}).sort()).toEqual(['gpt-5.4', 'minimax-m2']);
  });

  it('writes the account context limits, effort levels and per-model protocol', async () => {
    const { manager, config } = managerFor({});

    await manager.connectWithToken('gho_supplied_token');

    expect(config.custom_provider?.['github-copilot']?.models?.['gpt-5.4']).toMatchObject({
      limit: { context: 272000, output: 128000 },
      thinking: { effortOptions: ['none', 'low', 'medium', 'high', 'xhigh'] },
      provider: { api: 'openai-responses' },
    });
    expect(config.custom_provider?.['github-copilot']?.models?.['minimax-m2']).toMatchObject({
      limit: { context: 200000, output: 64000 },
      provider: { api: 'openai-completions' },
    });
  });

  it('keeps user edits to a model across a catalog refresh', async () => {
    const config = createConfig(true);
    config.custom_provider = {
      'github-copilot': {
        api: 'openai-completions',
        models: {
          'gpt-5.4': {
            limit: { context: 100000 },
            thinking: { effortOptions: ['low', 'high'] },
          },
        },
      },
    };
    const { manager } = managerFor({ config });

    await manager.connectWithToken('gho_supplied_token');

    expect(config.custom_provider?.['github-copilot']?.models?.['gpt-5.4']).toMatchObject({
      limit: { context: 100000, output: 128000 },
      thinking: { effortOptions: ['low', 'high'] },
    });
  });

  it('reports the models that still need the account terms accepted', async () => {
    const { manager } = managerFor({});

    await manager.connectWithToken('gho_supplied_token');

    expect(manager.getStatus().policyOptInRequired).toEqual(['claude-opus-4.8']);
  });

  it('refuses to fetch models without a credential', async () => {
    const { manager } = managerFor({});

    await expect(manager.refreshModels()).rejects.toMatchObject({
      status: 409,
      code: 'OAUTH_NOT_CONNECTED',
    });
  });

  it('fails the refresh when the account catalog cannot be read', async () => {
    const config = createConfig(true);
    const manager = new CopilotOAuthManager({
      configGetter: () => config,
      authStorageFactory: () => createAuthStorage({ type: 'oauth' }),
      updateByokConfig: createUpdater(config),
      catalogGetter: async () => {
        throw new Error('Copilot model discovery failed (HTTP 500).');
      },
    });

    await expect(manager.refreshModels()).rejects.toMatchObject({ code: 'MODEL_DISCOVERY_FAILED' });
  });

  it('reads stored credentials back through the shared provider credential store', async () => {
    const config = createConfig(true);
    config.custom_provider = {
      'github-copilot': {
        api: 'openai-completions',
        models: { 'gpt-5.4': { limit: { context: 272000 } } },
      },
    };
    const { manager, authStorage } = managerFor({
      config,
      authStorage: createAuthStorage({ type: 'oauth' }),
    });

    const status = await manager.refreshModels();

    expect(status.state).toBe('connected');
    expect(status.credentialSource).toBe('oauth');
    expect(authStorage.storeToken).not.toHaveBeenCalled();
  });

  it('clears credentials for its own provider only', async () => {
    const { manager, authStorage } = managerFor({ authStorage: createAuthStorage({ type: 'oauth' }) });

    manager.removeCredentials('github-copilot');
    expect(authStorage.remove).toHaveBeenCalledWith('github-copilot');
    expect(() => manager.removeCredentials('openai-codex')).toThrow(CopilotOAuthError);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import type { LocalRuntimeConfig } from './contracts.js';
import { CopilotOAuthManager } from './copilot-oauth.js';
import { createLocalModelSystemConfigPort, initializeModelSystem } from './initialize.js';

function createConfig(copilotOAuth: boolean): LocalRuntimeConfig {
  return {
    dataDir: '/tmp/model-system-initialize-test',
    provider: {},
    beta: { copilotOAuth },
  };
}

function createConfigPort(config: LocalRuntimeConfig) {
  const port = createLocalModelSystemConfigPort(() => config);
  return {
    ...port,
    updateByok: vi.fn(async (mutate) => {
      const draft = { custom_provider: config.custom_provider };
      await mutate(draft as never, config);
      config.custom_provider = draft.custom_provider as LocalRuntimeConfig['custom_provider'];
      return { config };
    }),
  };
}

describe('initializeModelSystem', () => {
  it('enables the connector without any explicit configuration', () => {
    const config = createConfig(true);
    delete config.beta;
    const owner = initializeModelSystem({ config: createConfigPort(config) });

    // A distribution that ships this connector can use it without editing config
    // first: only an explicit `beta.copilotOAuth: false` hides it.
    expect(owner.copilotOAuth.getStatus().state).not.toBe('hidden');
  });

  it('composes the Copilot connector on the owner, wired to the profile config', () => {
    const owner = initializeModelSystem({ config: createConfigPort(createConfig(true)) });

    expect(owner.copilotOAuth).toBeInstanceOf(CopilotOAuthManager);
    // The flag reaches the connector through the same config port the rest of the
    // model system reads, so `beta.copilotOAuth: false` hides it again.
    expect(owner.copilotOAuth.getStatus()).toEqual({
      state: 'disconnected',
      providerId: 'github-copilot',
    });
    expect(
      initializeModelSystem({ config: createConfigPort(createConfig(false)) }).copilotOAuth.getStatus(),
    ).toEqual({ state: 'hidden', providerId: 'github-copilot' });
  });

  it('keeps the Codex connector and the resolver on the same owner', () => {
    const owner = initializeModelSystem({ config: createConfigPort(createConfig(true)) });

    expect(owner.oauth).toBeDefined();
    expect(owner.resolver).toBeDefined();
    expect(owner.providers).toBeDefined();
    expect(typeof owner.listProviderPresets).toBe('function');
  });

  it('re-probes the stored Copilot catalog at initialization', async () => {
    const config = createConfig(true);
    const storagePath = mkdtempSync(join(tmpdir(), 'model-system-initialize-copilot-'));
    config.dataDir = storagePath;
    const storage = AuthStorage.create(join(storagePath, 'codex-auth.json'));
    storage.set('github-copilot', { type: 'api_key', key: 'gho_init_token' });
    config.custom_provider = {
      'github-copilot': {
        api: 'openai-completions',
        kind: 'oauth',
        enabled: true,
        options: { authMode: 'oauth' },
        models: { 'gpt-5.4': { name: 'GPT-5.4', tool_call: true } },
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        data: [
          {
            id: 'gpt-6-sol',
            name: 'GPT-6 Sol',
            model_picker_enabled: true,
            capabilities: {
              type: 'chat',
              limits: { max_prompt_tokens: 400000, max_output_tokens: 128000 },
              supports: { tool_calls: true },
            },
            supported_endpoints: ['/chat/completions'],
          },
        ],
      }),
    }));
    const owner = initializeModelSystem({
      config: createConfigPort(config),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Fire-and-forget at init: wait for the probe to settle.
    await owner.copilotOAuth.refreshCatalogInBackground();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.githubcopilot.com/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(config.custom_provider?.['github-copilot']?.models?.['gpt-6-sol']).toMatchObject({
      limit: { context: 400000 },
    });
  });

  it('stays offline at initialization when no Copilot provider is configured', () => {
    const fetchImpl = vi.fn();
    initializeModelSystem({
      config: createConfigPort(createConfig(true)),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

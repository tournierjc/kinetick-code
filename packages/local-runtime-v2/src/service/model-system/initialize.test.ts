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
});

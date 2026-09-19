import { describe, expect, it } from 'vitest';

import {
  firstBuiltinModel,
  planCustomProviderResolution,
  planMinimaxApiResolution,
  readStringRecord,
} from './model-resolver-byok.js';

const FALLBACK_CATALOG = {
  contextWindow: 1,
  maxTokens: 2,
  fromCatalog: false,
} as const;
const MESSAGES_API_COMPAT_PATH = String.fromCodePoint(
  0x61,
  0x6e,
  0x74,
  0x68,
  0x72,
  0x6f,
  0x70,
  0x69,
  0x63,
);

describe('MiniMax API BYOK planning', () => {
  it('returns absent when the source is not configured and fails closed without a key', () => {
    expect(
      planMinimaxApiResolution({
        byok: undefined,
        providerConfig: undefined,
        modelId: 'model',
        catalog: FALLBACK_CATALOG,
      }),
    ).toBeUndefined();
    expect(() =>
      planMinimaxApiResolution({
        byok: { minimax_api: { apiKey: '   ' } },
        providerConfig: undefined,
        modelId: 'model',
        catalog: FALLBACK_CATALOG,
      }),
    ).toThrow('apiKey is not configured');
  });

  it('uses fallback, catalog, and user-owned context overrides without managed limits', () => {
    const fallback = planMinimaxApiResolution({
      byok: { minimax_api: { apiKey: ' key ' } },
      providerConfig: undefined,
      modelId: 'model',
      catalog: FALLBACK_CATALOG,
    });
    expect(fallback).toMatchObject({
      apiKey: 'key',
      contextWindow: 200_000,
      maxTokens: 16_384,
    });
    expect([
      `https://api.minimaxi.com/${MESSAGES_API_COMPAT_PATH}`,
      `https://api.minimax.io/${MESSAGES_API_COMPAT_PATH}`,
    ]).toContain(fallback?.baseUrl);

    expect(
      planMinimaxApiResolution({
        byok: { minimax_api: { apiKey: 'key', baseURL: ' https://byok.example ' } },
        providerConfig: undefined,
        modelId: 'model',
        catalog: { contextWindow: 10, maxTokens: 20, fromCatalog: true },
      }),
    ).toMatchObject({
      baseUrl: 'https://byok.example',
      contextWindow: 10,
      maxTokens: 20,
    });

    expect(
      planMinimaxApiResolution({
        byok: {
          minimax_api: {
            apiKey: 'key',
            modelContextLimits: { 'MiniMax-M3': 1_000_000 },
          },
        },
        providerConfig: {
          minimax: {
            models: { 'MiniMax-M3': { limit: { context: 30, output: 40 } } },
          },
        },
        modelId: 'MiniMax-M3',
        catalog: { contextWindow: 10, maxTokens: 20, fromCatalog: true },
      }),
    ).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000 });
  });
});

describe('custom BYOK planning', () => {
  it('returns absent for missing, disabled, and unknown model configurations', () => {
    const base = { provider: 'custom_provider:work', providerKey: 'work', modelId: 'model' };
    expect(planCustomProviderResolution({ ...base, byok: undefined })).toBeUndefined();
    expect(
      planCustomProviderResolution({
        ...base,
        byok: { custom_provider: { work: { enabled: false } } },
      }),
    ).toBeUndefined();
    expect(
      planCustomProviderResolution({
        ...base,
        byok: { custom_provider: { work: { models: {} } } },
      }),
    ).toBeUndefined();
  });

  it('fails closed when custom provider credentials are incomplete', () => {
    const base = {
      provider: 'custom_provider:work',
      providerKey: 'work',
      modelId: 'model',
    };
    expect(() =>
      planCustomProviderResolution({
        ...base,
        byok: { custom_provider: { work: { models: { model: {} } } } },
      }),
    ).toThrow('api_key not configured');
    expect(() =>
      planCustomProviderResolution({
        ...base,
        byok: {
          custom_provider: {
            work: {
              options: { apiKey: 'key' },
              models: { model: {} },
            },
          },
        },
      }),
    ).toThrow('base_url not configured');
  });

  it('normalizes API selection, merged string headers, and fallback limits', () => {
    const providerHeaders: Record<string, string> = {
      'X-Shared': 'provider',
      'X-Provider': 'yes',
    };
    Reflect.set(providerHeaders, 'Ignored', 1);
    const base = {
      provider: 'custom_provider:work',
      providerKey: 'work',
      modelId: 'model',
    };
    const plan = planCustomProviderResolution({
      ...base,
      byok: {
        custom_provider: {
          work: {
            api: 'openai-completions',
            options: {
              apiKey: ' key ',
              baseURL: ' https://custom.example ',
              headers: providerHeaders,
            },
            models: {
              model: {
                headers: { 'x-shared': 'model', 'X-Model': 'yes' },
              },
            },
          },
        },
      },
    });
    expect(plan).toMatchObject({
      api: 'openai-completions',
      apiKey: 'key',
      baseUrl: 'https://custom.example',
      contextWindow: 200_000,
      maxTokens: 16_384,
      configHeaders: {
        'X-Provider': 'yes',
        'x-shared': 'model',
        'X-Model': 'yes',
      },
    });

    expect(
      planCustomProviderResolution({
        ...base,
        byok: {
          custom_provider: {
            work: {
              api: 'other',
              options: { apiKey: 'key', baseURL: 'https://custom.example' },
              models: { model: { limit: { context: 5, output: 6 } } },
            },
          },
        },
      }),
    ).toMatchObject({
      api: 'anthropic-messages',
      contextWindow: 5,
      maxTokens: 6,
    });
  });

  it('prefers a model-level wire protocol over the provider default', () => {
    // One provider can front models that only speak different protocols upstream
    // (GitHub Copilot: Claude on Messages, GPT-5 on Responses, Gemini on
    // Completions), so `models.<id>.provider.api` overrides the provider's `api`.
    const planFor = (rawModel: string) =>
      planCustomProviderResolution({
        provider: 'custom_provider:github-copilot',
        providerKey: 'github-copilot',
        modelId: 'gpt-5.4',
        byok: {
          custom_provider: {
            'github-copilot': {
              api: 'openai-completions',
              kind: 'oauth',
              options: { baseURL: 'https://api.githubcopilot.com' },
              models: { 'gpt-5.4': JSON.parse(rawModel) },
            },
          },
        },
      })?.api;

    expect(planFor('{"provider":{"api":"openai-responses"}}')).toBe('openai-responses');
    expect(planFor('{"provider":{"api":"anthropic-messages"}}')).toBe('anthropic-messages');
    // A model that declares no protocol of its own keeps the provider default.
    expect(planFor('{}')).toBe('openai-completions');
    expect(planFor('{"provider":{}}')).toBe('openai-completions');
    // The tree is restored from JSON, so the override may arrive malformed. Only a
    // recognized protocol switches it; anything else leaves the provider's own api.
    expect(planFor('{"provider":"openai-responses"}')).toBe('openai-completions');
    expect(planFor('{"provider":{"api":7}}')).toBe('openai-completions');
    expect(planFor('{"provider":null}')).toBe('openai-completions');
    expect(planFor('{"provider":{"api":"not-a-protocol"}}')).toBe('openai-completions');
    expect(planFor('{"provider":{"api":"openai-codex-responses"}}')).toBe(
      'openai-codex-responses',
    );
  });
});

describe('BYOK config helpers', () => {
  it('selects MiniMax first, then another configured provider', () => {
    expect(
      firstBuiltinModel({
        minimax: { models: { mini: {} } },
        other: { models: { other: {} } },
      }),
    ).toEqual({ provider: 'minimax', modelId: 'mini' });
    expect(firstBuiltinModel({ other: { models: { other: {} } } })).toEqual({
      provider: 'other',
      modelId: 'other',
    });
    expect(firstBuiltinModel({ empty: {} })).toBeUndefined();
  });

  it.each([undefined, null, [], 'invalid', {}, { Invalid: 1 }])(
    'rejects a non-string header record %j',
    (value) => {
      expect(readStringRecord(value)).toBeUndefined();
    },
  );

  it('keeps only string header values', () => {
    expect(readStringRecord({ Keep: 'yes', Drop: 1 })).toEqual({ Keep: 'yes' });
  });
});

describe('custom BYOK compat overrides', () => {
  // Provider config is restored from on-disk JSON, so compat reaches planning untyped.
  const planWithCompat = (rawConfig: string) =>
    planCustomProviderResolution({
      provider: 'custom_provider:gateway',
      providerKey: 'gateway',
      modelId: 'kimi-k2-thinking',
      byok: {
        custom_provider: {
          gateway: {
            api: 'openai-completions',
            options: { apiKey: 'gateway-key', baseURL: 'https://gateway.example/v1' },
            models: { 'kimi-k2-thinking': JSON.parse(rawConfig) },
          },
        },
      },
    })?.modelCompat;

  it.each(['null', '"compat"', '7', '[]', '[{"supportsDeveloperRole":false}]'])(
    'ignores non-record compat value %s',
    (compat) => {
      expect(planWithCompat(`{"compat":${compat}}`)).toBeUndefined();
    },
  );

  it('is absent when the model declares no compat', () => {
    expect(planWithCompat('{}')).toBeUndefined();
  });

  it('keeps declared boolean and enum fields', () => {
    expect(
      planWithCompat(
        '{"compat":{"supportsDeveloperRole":false,"supportsStrictMode":false,"supportsReasoningEffort":false,"maxTokensField":"max_tokens","thinkingFormat":"deepseek","cacheControlFormat":"anthropic"}}',
      ),
    ).toEqual({
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
      cacheControlFormat: 'anthropic',
    });
  });

  it('preserves an explicit true so a permissive upstream stays declarable', () => {
    expect(planWithCompat('{"compat":{"supportsDeveloperRole":true}}')).toEqual({
      supportsDeveloperRole: true,
    });
  });

  it('drops a boolean field carrying a truthy string instead of a boolean', () => {
    expect(planWithCompat('{"compat":{"supportsDeveloperRole":"false"}}')).toBeUndefined();
  });

  it('drops enum fields outside the supported set', () => {
    expect(
      planWithCompat('{"compat":{"maxTokensField":"max_output_tokens","thinkingFormat":"kimi"}}'),
    ).toBeUndefined();
  });

  it('ignores unknown keys', () => {
    expect(planWithCompat('{"compat":{"unknownFlag":true,"supportsStore":false}}')).toEqual({
      supportsStore: false,
    });
  });

  it('keeps a valid field when a sibling field is malformed', () => {
    expect(
      planWithCompat('{"compat":{"supportsDeveloperRole":false,"supportsStrictMode":"no"}}'),
    ).toEqual({ supportsDeveloperRole: false });
  });

  it('does not inherit prototype pollution from the config record', () => {
    expect(
      planWithCompat('{"compat":{"__proto__":{"supportsDeveloperRole":false}}}'),
    ).toBeUndefined();
  });
});

describe('custom BYOK thinking shape', () => {
  const plan = (
    providerKey: string,
    baseUrl: string,
    compat?: Record<string, unknown>,
    modelId = 'deepseek-v4-flash',
  ) =>
    planCustomProviderResolution({
      provider: `custom_provider:${providerKey}`,
      providerKey,
      modelId,
      byok: {
        custom_provider: {
          [providerKey]: {
            api: 'openai-completions',
            options: { apiKey: 'sk-test', baseURL: baseUrl },
            models: {
              [modelId]: { ...(compat ? { compat } : {}) },
            },
          },
        },
      },
    });

  it('applies the thinking shape the endpoint family declares', () => {
    expect(plan('deepseek', 'https://api.deepseek.com')?.modelCompat).toMatchObject({
      thinkingFormat: 'deepseek',
      supportsReasoningEffort: true,
    });
  });

  it('keeps a thinking format the model declares, and leaves strangers alone', () => {
    expect(
      plan('deepseek', 'https://api.deepseek.com', { thinkingFormat: 'openai' })?.modelCompat,
    ).toMatchObject({ thinkingFormat: 'openai' });

    // The model id identifies the family when the endpoint does not: a gateway
    // that fronts `deepseek-v4-*` still needs DeepSeek's thinking shape.
    expect(plan('work', 'https://gateway.example/v1')?.modelCompat).toMatchObject({
      thinkingFormat: 'deepseek',
    });

    // A model that belongs to nobody gets no shape at all.
    expect(
      plan('work', 'https://api.openai.com/v1', undefined, 'gpt-5-mini')?.modelCompat,
    ).toBeUndefined();
  });
});

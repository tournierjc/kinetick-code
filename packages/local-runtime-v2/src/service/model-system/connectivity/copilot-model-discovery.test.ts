import { describe, expect, it, vi } from 'vitest';

import {
  CopilotModelDiscoveryClient,
  CopilotModelDiscoveryHttpError,
  copilotBaseUrlFromToken,
} from './copilot-model-discovery.js';

/**
 * Excerpt of a `GET https://api.githubcopilot.com/models` response (2026-09-19):
 * the context limits, reasoning-effort lists and policy states are the values the
 * API returned, not expectations written from documentation. Unused fields are
 * dropped so the fixture stays readable. Entries the filters drop are kept on
 * purpose, so the filters stay covered.
 */
const ACCOUNT_CATALOG = {
  data:   [
    {
      "id": "claude-opus-4.7",
      "name": "Claude Opus 4.7",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/v1/messages",
        "/chat/completions"
      ],
      "policy": {
        "state": "disabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 264000,
          "max_prompt_tokens": 200000,
          "max_output_tokens": 64000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        }
      }
    },
    {
      "id": "claude-opus-4.8",
      "name": "Claude Opus 4.8",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/v1/messages",
        "/chat/completions"
      ],
      "policy": {
        "state": "disabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 264000,
          "max_prompt_tokens": 200000,
          "max_output_tokens": 64000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        }
      }
    },
    {
      "id": "claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/chat/completions",
        "/v1/messages"
      ],
      "policy": {
        "state": "enabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 264000,
          "max_prompt_tokens": 200000,
          "max_output_tokens": 64000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "low",
            "medium",
            "high",
            "max"
          ]
        }
      }
    },
    {
      "id": "claude-haiku-4.5",
      "name": "Claude Haiku 4.5",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/chat/completions",
        "/v1/messages"
      ],
      "policy": {
        "state": "enabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 144000,
          "max_prompt_tokens": 128000,
          "max_output_tokens": 32000
        },
        "supports": {
          "tool_calls": true,
          "vision": true
        }
      }
    },
    {
      "id": "gemini-3.5-flash",
      "name": "Gemini 3.5 Flash",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/chat/completions"
      ],
      "policy": {
        "state": "enabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 264000,
          "max_prompt_tokens": 200000,
          "max_output_tokens": 64000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "minimal",
            "low",
            "medium",
            "high"
          ]
        }
      }
    },
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/responses",
        "/chat/completions",
        "ws:/responses"
      ],
      "policy": {
        "state": "enabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 400000,
          "max_prompt_tokens": 272000,
          "max_output_tokens": 128000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "none",
            "low",
            "medium",
            "high",
            "xhigh"
          ]
        }
      }
    },
    {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/responses",
        "ws:/responses"
      ],
      "policy": {
        "state": "disabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 400000,
          "max_prompt_tokens": 272000,
          "max_output_tokens": 128000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "none",
            "low",
            "medium",
            "high",
            "xhigh"
          ]
        }
      }
    },
    {
      "id": "gpt-5-mini",
      "name": "GPT-5 mini",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/chat/completions",
        "/responses",
        "ws:/responses"
      ],
      "policy": {
        "state": "enabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 264000,
          "max_prompt_tokens": 128000,
          "max_output_tokens": 64000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "low",
            "medium",
            "high"
          ]
        }
      }
    },
    {
      "id": "gpt-5.3-codex",
      "name": "GPT-5.3-Codex",
      "model_picker_enabled": true,
      "supported_endpoints": [
        "/responses",
        "ws:/responses"
      ],
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 400000,
          "max_prompt_tokens": 272000,
          "max_output_tokens": 128000
        },
        "supports": {
          "tool_calls": true,
          "vision": true,
          "reasoning_effort": [
            "low",
            "medium",
            "high",
            "xhigh"
          ]
        }
      }
    },
    {
      "id": "gpt-4o",
      "name": "GPT-4o",
      "model_picker_enabled": false,
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 128000,
          "max_prompt_tokens": 64000,
          "max_output_tokens": 4096
        },
        "supports": {
          "tool_calls": true,
          "vision": true
        }
      }
    },
    {
      "id": "gpt-4.1",
      "name": "GPT-4.1",
      "model_picker_enabled": false,
      "policy": {
        "state": "enabled"
      },
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 128000,
          "max_prompt_tokens": 64000,
          "max_output_tokens": 16384
        },
        "supports": {
          "tool_calls": true,
          "vision": true
        }
      }
    },
    {
      "id": "copilot-search-a",
      "name": "Copilot Agent A",
      "model_picker_enabled": false,
      "supported_endpoints": [
        "/chat/completions"
      ],
      "capabilities": {
        "type": "chat",
        "limits": {
          "max_context_window_tokens": 260000,
          "max_prompt_tokens": 244000,
          "max_output_tokens": 16000
        },
        "supports": {
          "tool_calls": true
        }
      }
    },
    {
      "id": "text-embedding-3-small",
      "name": "Embedding V3 small",
      "model_picker_enabled": false,
      "capabilities": {
        "type": "embeddings"
      }
    }
  ],
} as const;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createClient(payload: unknown = ACCOUNT_CATALOG, status = 200) {
  const fetchImpl = vi.fn(async () => jsonResponse(payload, status));
  const client = new CopilotModelDiscoveryClient(fetchImpl as unknown as typeof fetch);
  return { client, fetchImpl };
}

const CREDENTIALS = { token: 'copilot-token' };

describe('CopilotModelDiscoveryClient', () => {
  it('reads the account context and output limits per model', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.models['claude-opus-4.8']?.limit).toEqual({ context: 200000, output: 64000 });
    expect(provider.models['claude-haiku-4.5']?.limit).toEqual({ context: 128000, output: 32000 });
    expect(provider.models['gpt-5.5']?.limit).toEqual({ context: 272000, output: 128000 });
    expect(provider.models['gemini-3.5-flash']?.limit).toEqual({ context: 200000, output: 64000 });
  });

  it('reads the reasoning-effort levels the account can select', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.models['claude-opus-4.8']?.thinking?.effortOptions).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(provider.models['gpt-5.4']?.thinking?.effortOptions).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(provider.models['gemini-3.5-flash']?.thinking?.effortOptions).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(provider.models['gpt-5-mini']?.thinking?.effortOptions).toEqual(['low', 'medium', 'high']);
  });

  it('marks non-reasoning models as such instead of inventing an effort list', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.models['claude-haiku-4.5']?.reasoning).toBe(false);
    expect(provider.models['claude-haiku-4.5']?.thinking).toBeUndefined();
    expect(provider.models['claude-opus-4.8']?.reasoning).toBe(true);
  });

  it('routes each model to the wire protocol it advertises', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    // Claude answers natively on /v1/messages even when chat completions is also listed.
    expect(provider.models['claude-opus-4.8']?.provider).toEqual({ api: 'anthropic-messages' });
    expect(provider.models['claude-sonnet-4.6']?.provider).toEqual({ api: 'anthropic-messages' });
    expect(provider.models['claude-haiku-4.5']?.provider).toEqual({ api: 'anthropic-messages' });
    // The GPT-5 family is responses-only, so chat completions must not be chosen.
    expect(provider.models['gpt-5.5']?.provider).toEqual({ api: 'openai-responses' });
    expect(provider.models['gpt-5.3-codex']?.provider).toEqual({ api: 'openai-responses' });
    expect(provider.models['gpt-5.4']?.provider).toEqual({ api: 'openai-responses' });
    expect(provider.models['gemini-3.5-flash']?.provider).toEqual({ api: 'openai-completions' });
  });

  it('carries vision and tool support into the model entry', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.models['claude-opus-4.8']).toMatchObject({
      name: 'Claude Opus 4.8',
      attachment: true,
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    });
  });

  it('drops internal, embedding and picker-hidden entries', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    expect(Object.keys(provider.models)).not.toContain('copilot-search-a');
    expect(Object.keys(provider.models)).not.toContain('text-embedding-3-small');
    expect(Object.keys(provider.models)).not.toContain('gpt-4o');
    expect(Object.keys(provider.models)).not.toContain('gpt-4.1');
    expect(Object.keys(provider.models)).toHaveLength(9);
  });

  it('reports the models the account cannot call until its terms are accepted', async () => {
    const { client } = createClient();
    const { policyOptInRequired } = await client.discover(CREDENTIALS);

    expect([...policyOptInRequired].sort()).toEqual([
      'claude-opus-4.7',
      'claude-opus-4.8',
      'gpt-5.5',
    ]);
  });

  it('declares a provider entry the resolver can drive', async () => {
    const { client } = createClient();
    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.api).toBe('openai-completions');
    expect(provider.kind).toBe('oauth');
    expect(provider.enabled).toBe(true);
    expect(provider.options).toMatchObject({
      authMode: 'oauth',
      baseURL: 'https://api.githubcopilot.com',
    });
    expect(provider.options?.headers).toMatchObject({
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.107.0',
    });
  });

  it('reads a representative account catalog while keeping the bearer token off the payload', async () => {
    const { client, fetchImpl } = createClient();
    await client.discover(CREDENTIALS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.githubcopilot.com/models');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer copilot-token');
    expect(JSON.stringify(ACCOUNT_CATALOG)).not.toContain('copilot-token');
  });

  it('honours an account proxy endpoint from the token instead of the default host', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACCOUNT_CATALOG));
    const client = new CopilotModelDiscoveryClient(fetchImpl as unknown as typeof fetch);
    await client.discover({ token: 'copilot-token', baseUrl: 'https://api.business.githubcopilot.com' });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.business.githubcopilot.com/models');
  });

  it('surfaces the status and never the response body on failure', async () => {
    const { client } = createClient({ message: 'bad credentials copilot-token' }, 401);

    await expect(client.discover(CREDENTIALS)).rejects.toThrow(
      'Copilot model discovery failed (HTTP 401).',
    );
  });

  it('reports its own failure as a typed error that carries the status', async () => {
    const { client } = createClient({ message: 'bad credentials copilot-token' }, 401);

    await expect(client.discover(CREDENTIALS)).rejects.toBeInstanceOf(
      CopilotModelDiscoveryHttpError,
    );
    await expect(client.discover(CREDENTIALS)).rejects.toMatchObject({ status: 401 });
  });

  it('replaces a transport error with the generic message', async () => {
    // A transport error can quote the request, so it must not reach the caller.
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up while sending Bearer copilot-token');
    });
    const client = new CopilotModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(client.discover(CREDENTIALS)).rejects.toThrow(
      'Copilot model discovery failed. Retry connecting or reopen model settings.',
    );
  });

  it('rejects a catalog with no usable model', async () => {
    const { client } = createClient({ data: [{ id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } }] });

    await expect(client.discover(CREDENTIALS)).rejects.toThrow('Empty Copilot model catalog.');
  });

  it('rejects a payload that is not a model catalog', async () => {
    for (const payload of [null, {}, { data: 'nope' }, { data: [] }]) {
      await expect(createClient(payload).client.discover(CREDENTIALS)).rejects.toThrow(
        /Invalid|Empty/u,
      );
    }
  });

  it('reads the account proxy endpoint out of a token', () => {
    expect(
      copilotBaseUrlFromToken('tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;'),
    ).toBe('https://api.individual.githubcopilot.com');
    expect(copilotBaseUrlFromToken('tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;')).toBe(
      'https://api.business.githubcopilot.com',
    );
    expect(copilotBaseUrlFromToken('tid=1;exp=2')).toBeUndefined();
    expect(copilotBaseUrlFromToken('proxy-ep=not a host;')).toBeUndefined();
  });

  it('trims a base URL that already ends in a slash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACCOUNT_CATALOG));
    const client = new CopilotModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await client.discover({ token: 'copilot-token', baseUrl: 'https://api.githubcopilot.com/' });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.githubcopilot.com/models');
  });

  // Synthetic entries: the live catalog does not currently contain these shapes,
  // and the filters have to hold when it does.
  it('requires an HTTP chat endpoint and ignores the streaming transport', async () => {
    const { client } = createClient({
      data: [
        {
          id: 'no-endpoint',
          model_picker_enabled: true,
          capabilities: { type: 'chat', limits: { max_prompt_tokens: 1000 } },
        },
        {
          id: 'stream-only',
          model_picker_enabled: true,
          supported_endpoints: ['ws:/responses'],
          capabilities: { type: 'chat', limits: { max_prompt_tokens: 1000 } },
        },
        {
          id: 'messages-only',
          model_picker_enabled: true,
          supported_endpoints: ['/v1/messages'],
          capabilities: { type: 'chat', limits: { max_prompt_tokens: 1000, max_output_tokens: 500 } },
        },
      ],
    });

    const { provider } = await client.discover(CREDENTIALS);

    expect(Object.keys(provider.models)).toEqual(['messages-only']);
    expect(provider.models['messages-only']).toMatchObject({
      provider: { api: 'anthropic-messages' },
      limit: { context: 1000, output: 500 },
      reasoning: false,
    });
  });

  it('falls back to the full window when only it is reported, and keeps output absent', async () => {
    const { client } = createClient({
      data: [
        {
          id: 'window-only',
          model_picker_enabled: true,
          supported_endpoints: ['/chat/completions'],
          capabilities: {
            type: 'chat',
            limits: { max_context_window_tokens: 64000 },
            supports: { tool_calls: false },
          },
        },
      ],
    });

    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.models['window-only']).toMatchObject({
      // No prompt budget is reported, so the window is what this runtime admits.
      limit: { context: 64000 },
      tool_call: false,
      attachment: false,
      modalities: { input: ['text'], output: ['text'] },
      reasoning: false,
    });
    expect(provider.models['window-only']?.limit?.output).toBeUndefined();
  });

  it('normalizes effort casing and duplicates', async () => {
    const { client } = createClient({
      data: [
        {
          id: 'model',
          model_picker_enabled: true,
          supported_endpoints: ['/chat/completions'],
          capabilities: { type: 'chat', supports: { reasoning_effort: ['HIGH', ' high ', 'low'] } },
        },
      ],
    });

    const { provider } = await client.discover(CREDENTIALS);

    expect(provider.models['model']?.thinking?.effortOptions).toEqual(['high', 'low']);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { CopilotModelDiscoveryClient } from './copilot-model-discovery.js';

/**
 * Verbatim excerpt of a real `GET https://api.githubcopilot.com/models` response
 * (account: tournierjc, captured 2026-09-19). Field values — context limits and
 * reasoning-effort lists in particular — are the ones the API returned, not
 * expectations written from documentation; unused fields are dropped so the
 * fixture stays readable.
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

  it('rejects a catalog with no usable model', async () => {
    const { client } = createClient({ data: [{ id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } }] });

    await expect(client.discover(CREDENTIALS)).rejects.toThrow('Empty Copilot model catalog.');
  });
});

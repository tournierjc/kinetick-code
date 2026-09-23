import { describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { CREDENTIAL_HEADER_NAMES, withClearedCredentialHeaders } from "@mavis/shared";
import { composeStreamFn } from "../../../src/pi-turn-runner/llm.js";
import type { LLMModelConfig } from "../../../src/pi-turn-runner/types.js";

function fakeModel(): Model<any> {
  return {
    id: "local-model",
    name: "local-model",
    api: "openai-completions",
    provider: "custom_provider:local",
    baseUrl: "http://127.0.0.1:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  } as Model<any>;
}

const CONTEXT: Context = { messages: [] };

function finalMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "custom_provider:local",
    model: "local-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

function stream(): AssistantMessageEventStream {
  const events: AssistantMessageEvent[] = [];
  const final = finalMessage();
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length)
            return { value: events[index++], done: false };
          return { value: undefined, done: true };
        },
      } as AsyncIterableIterator<AssistantMessageEvent>;
    },
    async result() {
      return final;
    },
  } as unknown as AssistantMessageEventStream;
}

/** Records every option set the composed stream function hands the provider. */
function capturingStreamFn(captured: Array<Record<string, unknown>>): StreamFn {
  return (async (_model, _context, options) => {
    captured.push((options ?? {}) as Record<string, unknown>);
    return stream();
  }) as StreamFn;
}

function modelConfig(
  captured: Array<Record<string, unknown>>,
  overrides: Partial<LLMModelConfig> = {},
): LLMModelConfig {
  return {
    model: fakeModel(),
    apiKey: "kcode-no-auth",
    streamFn: capturingStreamFn(captured),
    ...overrides,
  };
}

describe("composeStreamFn on an endpoint that needs no authentication", () => {
  it("clears both credential headers while still handing the transport its key", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const composed = composeStreamFn(
      modelConfig(captured, { unauthenticatedEndpoint: true }),
    );

    // The turn hands the transport the placeholder key it needs to build a
    // client; the credential header that would carry it is what gets cleared.
    await composed(fakeModel(), CONTEXT, { apiKey: "kcode-no-auth" });

    expect(captured).toHaveLength(1);
    expect(captured[0].apiKey).toBe("kcode-no-auth");
    expect(captured[0].headers).toEqual({ authorization: null, "x-api-key": null });
  });

  it("clears the credential headers a caller passes, keeping its other headers", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const composed = composeStreamFn(
      modelConfig(captured, {
        headers: { "x-session-id": "session-1" },
        unauthenticatedEndpoint: true,
      }),
    );

    // The compaction path re-supplies a key and headers on the call itself.
    await composed(fakeModel(), CONTEXT, {
      apiKey: "kcode-no-auth",
      headers: { "x-trace": "trace-1" },
    });

    expect(captured[0].apiKey).toBe("kcode-no-auth");
    expect(captured[0].headers).toEqual({
      "x-session-id": "session-1",
      authorization: null,
      "x-trace": "trace-1",
      "x-api-key": null,
    });
  });

  it("keeps a credential header the caller declared on purpose", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const composed = composeStreamFn(
      modelConfig(captured, {
        headers: { Authorization: "Bearer relay-token" },
        unauthenticatedEndpoint: true,
      }),
    );

    await composed(fakeModel(), CONTEXT, {});

    expect(captured[0].headers).toEqual({
      Authorization: "Bearer relay-token",
      "x-api-key": null,
    });
  });

  it("leaves every header untouched for an authenticated endpoint", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const composed = composeStreamFn(modelConfig(captured));

    await composed(fakeModel(), CONTEXT, { headers: { "x-trace": "trace-1" } });

    expect(captured[0].headers).toEqual({ "x-trace": "trace-1" });
  });
});

describe("withClearedCredentialHeaders", () => {
  it("names both credential headers the supported protocols use", () => {
    expect([...CREDENTIAL_HEADER_NAMES]).toEqual(["authorization", "x-api-key"]);
  });

  it("is case-insensitive about headers the caller already set", () => {
    expect(withClearedCredentialHeaders({ Authorization: "Bearer relay" })).toEqual({
      Authorization: "Bearer relay",
      "x-api-key": null,
    });
    expect(withClearedCredentialHeaders({ "X-Api-Key": "relay" })).toEqual({
      "X-Api-Key": "relay",
      authorization: null,
    });
  });

  it("works without headers at all", () => {
    expect(withClearedCredentialHeaders(undefined)).toEqual({
      authorization: null,
      "x-api-key": null,
    });
  });
});

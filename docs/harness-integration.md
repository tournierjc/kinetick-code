# Driving Kinetick Code from another process

Kinetick Code is a program other programs can run. Two transports exist, and both
are stable enough that a script, a CI job, an editor, or another agent harness
can depend on them.

| Transport | Command | Shape |
| --- | --- | --- |
| Headless run | `kcode exec` | One process, one result, exits when the turn ends. |
| Agent Client Protocol | `kcode acp` | One long-lived process over stdio, many sessions and turns. |

Everything below was observed on a build of this repository against a real
provider. The verification method is stated per claim, because a documented
contract that nobody exercised is a claim, not a fact.

## 1. Headless runs: `kcode exec`

The prompt arrives as an argument or on stdin:

```bash
kcode exec "Summarize the failing tests" --cwd /work/repo

printf 'Summarize the failing tests' | kcode exec --input - --input-format text
```

`--input -` is the documented form for input that arrives from a pipe. The
process never waits on a terminal: with stdout, stderr and stdin all piped, a
run completes and exits.

Useful flags for callers: `--cwd`, `--file` (repeatable), `--model`,
`--effort`, `--prompt-mode`, `--config`, `--session <id>`, `--continue`,
`--timeout`, `--max-steps`, `--output-schema`, `-o/--output-last-message`, and
`--permission`. The full contract lives in `packages/tui/src/cli/contract.ts`.

### Machine-readable output

`--output-format json` prints one JSON document on stdout and nothing else:

```json
{
  "schemaVersion": 1,
  "type": "exec.result",
  "runId": "exec_turn_...",
  "sessionId": "mvs_...",
  "turnId": "turn_...",
  "status": "succeeded",
  "output": "PONG",
  "model": { "providerId": "custom_provider:github-copilot", "modelId": "gpt-5-mini" },
  "usage": { "inputTokens": 9139, "outputTokens": 134, "totalTokens": 9273 },
  "usageSource": "completed_responses",
  "usageIncomplete": false,
  "durationMs": 3656
}
```

`packages/tui/src/headless/contract.ts` defines the shape and
`headless-contract.test.ts` pins `schemaVersion: 1`, the structured-output path,
and the rule that a blocked interactive prompt is never reported as a result.

`--output-format stream-json` prints newline-delimited events for callers that
want to follow progress. A completed run emitted exactly:

```
exec.started, session.started, turn.started, item.started,
item.completed, turn.completed, exec.completed
```

No ANSI escapes appear in either format when the output is not a terminal.

### Continuing a conversation

A run reports its `sessionId`; a later process resumes that session:

```bash
printf 'What did I ask you to do first?' | kcode exec --session mvs_... --input - --output-format json
```

The follow-up runs in a new process and still sees the earlier turn.
`--continue` resumes the latest active session in `--cwd` instead.

### Acting, not just answering

A headless run executes tools. `--permission` selects the policy for that run:

| Value | Behaviour |
| --- | --- |
| `smart` (default) | Tools run without asking. |
| `full` | Full access, including edits outside the workspace. |
| `off` | Tool use disabled. |

There is no `ask` value: a run that blocks on a human prompt cannot be part of
an automated pipeline. A caller that needs approvals uses ACP, which has an
interactive channel to ask on. This is enforced, not conventional — see the
`no interactive blocked result` case in `headless-contract.test.ts`.

### Failure is machine-readable too

A failing run reports its outcome through the exit code and a message on stderr;
stdout keeps carrying only results. The table is defined in
`packages/tui/src/headless/exit-policy.ts` and pinned by
`headless-exit-policy.test.ts`:

| Exit code | Meaning |
| --- | --- |
| 0 | The run succeeded. |
| 2 | The invocation itself was wrong. |
| 3 | Configuration. |
| 4 | Runtime failure; the caller can retry. |
| 6 | Timeout. |
| 7 | Step limit reached. |
| 70 | Internal error. |
| 130 | Cancelled. |
| 141 | The reader closed the pipe. |

Observed: an unavailable model exits `4` with an empty stdout and an
explanatory message on stderr.

## 2. Sessions: `kcode acp`

`kcode acp` speaks Agent Client Protocol (JSON-RPC over stdio, one message per
line) and serves editors and other client harnesses. It uses
`@agentclientprotocol/sdk`, so a client built with the same SDK needs no
adaptation.

The handshake a client performs:

1. `initialize` → `{protocolVersion: 1, agentInfo: {name: "minimax-code", ...},
   agentCapabilities: {loadSession, mcpCapabilities, promptCapabilities,
   sessionCapabilities}}`.
2. `session/new {cwd, mcpServers}` → a session id.
3. `session/prompt {sessionId, prompt: [{type: "text", text}]}` → a stop reason
   when the turn ends.
4. `session/update` notifications stream progress while that request is open.

Observed `sessionUpdate` kinds during ordinary work: `available_commands_update`,
`config_option_update`, `session_info_update`, `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`.

`tool_call` / `tool_call_update` carry the real command and its output
(`rawInput`, `rawOutput`), so a client can display or log what the agent
actually ran. A second `session/prompt` on the same session id continues the
conversation in one process.

### Controlling the session from the client

`session/new` advertises controls, and `session/set_config_option` sets them:

| Option | Values | Effect |
| --- | --- | --- |
| `permissionMode` | `default` (Ask), `auto` (Auto), `bypassPermissions` (Full access) | When the agent asks before acting. |
| `model` | the roster the session reports | Model for later turns. |
| `thinkingEffort` | `low`, `medium`, `high` | Reasoning effort for later turns. |

`modes` additionally offers `default` and `plan`.

### Approvals

When a tool call needs approval, the agent calls
`session/request_permission` and waits. The options are `allow-once`,
`allow-always`, and `deny`. The client answers with
`{outcome: {outcome: 'selected', optionId}}`, and the agent maps the answer in
`packages/tui/src/acp/interactions.ts`: `allow-once` allows that call,
`allow-always` allows it and the equivalent later calls when the tool supports
it, and **any other answer, an error, or a closed connection denies**. A client
that fails to answer therefore blocks the action rather than permitting it.

Observed end to end from a client harness in Ask mode: writing to a path inside
the workspace and writing to `/tmp` ran without asking, while writing under
`~/.ssh` produced a permission request. Answering `allow-once` created the file;
answering `deny` left it absent and the agent reported the refusal. Tools that
need approval are decided by policy (`packages/agent-modules/permission`), not
by the mode alone — the mode decides how a matched rule is honoured.

## 3. Notes for callers

- Isolate state with `MINIMAX_DATA_DIR`; a caller gets its own config, sessions,
  and credentials rather than sharing the user's.
- Model ids are `<provider-id>/<model-id>`, and a configured provider's id is
  prefixed: `custom_provider:github-copilot/gpt-5-mini`.
- The egress guard applies to every run. A caller on a locked-down host keeps
  loopback, its configured providers, and `MCODE_ALLOWED_ORIGINS`; see
  [egress policy](egress-policy.md).
- Do not parse the human-readable `--output-format text`, and do not read
  progress from stdout there. The JSON and stream-json formats are the contract.

## 4. Verification scope

Recorded on 2026-09-19 (build `0.4.12`, Linux aarch64) against a configured
`custom_provider` running on GitHub Copilot, driven by a standalone client
script that spawns the CLI, pipes stdin, parses the envelope, and speaks ACP
through the SDK:

- `exec`: stdin prompt, JSON envelope, `stream-json` sequence, session
  continuation in a separate process, tool execution under `--permission full`,
  and the exit code for an unavailable model.
- `acp`: handshake, `session/new` controls, prompt with streamed updates, a
  tool call that created a file with the requested content, a second prompt on
  the same session, and an approval answered both ways.

Not verified: Windows and macOS hosts, enterprise Copilot accounts, MCP servers
passed in `session/new`, `session/cancel` against a running turn, and clients
that advertise filesystem or terminal capabilities instead of letting the agent
run tools itself.

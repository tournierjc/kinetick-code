# Driving Kinetick Code from another process

Kinetick Code is a program other programs can run. Three transports exist, and all
are stable enough that a script, a CI job, an editor, or another agent harness
can depend on them.

| Transport | Command | Shape |
| --- | --- | --- |
| Headless run | `kcode exec` | One process, one result, exits when the turn ends. |
| Agent Client Protocol | `kcode acp` | One long-lived process over stdio, many sessions and turns. |
| Session server | `kcode --server` | One long-lived HTTP process serving Sessions to external clients. |

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

## 3. Session server: `kcode --server`

`kcode --server` starts the Runtime without the TUI and serves Sessions over
HTTP, so an external application — a webapp, a mobile client, a dashboard —
can browse, drive, and supervise what is in the data directory. The server
reads Sessions, streams replies, starts turns, answers interactive prompts,
and exposes the Runtime surface (queue, delegation, skills, models, goals).
Like every other surface, it has no authentication: treat the bind address as
a trust boundary.

### Starting the server

```bash
kcode --server                             # http://127.0.0.1:8788, loopback only
kcode --server --host 0.0.0.0 --port 9430  # accept connections from other machines
MINIMAX_DATA_DIR=/work/kcode kcode --server  # serve an isolated data directory
```

The process prints `Kinetick Code session server listening on
http://<host>:<port>` and keeps serving until `SIGINT`, `SIGTERM`, or `SIGHUP`,
which shut the server and the Runtime down. `--server` cannot be combined with
a prompt, `--model`, `--session`, `--continue`, `--resume`, or `--tui-mode`;
`--host` and `--port` only apply to `--server`. Like `exec`, the server reads
and writes only its data directory: `MINIMAX_DATA_DIR` points it at an isolated
one, and omitting it serves the user's own Sessions.

There is no authentication. The default bind keeps the server on the loopback
interface; binding `0.0.0.0` or any non-loopback address prints a warning on
startup, because every client that can reach the address can read all Sessions
in the data directory and run turns on them. The write verbs (prompt, abort,
permission replies, delete) make a non-loopback bind an execution surface:
treat it as a local-network trust decision until authentication lands.

### Endpoint reference

Read endpoints answer JSON with `content-type: application/json;
charset=utf-8` and `cache-control: no-store`, and take their parameters in the
query string. Write endpoints take a JSON body (max 4 MiB). `<base>` is the
bind address — for example `http://127.0.0.1:8788` or, from another device on
the LAN, `http://192.168.1.50:9430`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/` | Server descriptor: name, version, and endpoint paths. |
| `GET` | `/health` | Liveness: `{"ok":true,"version":"0.5.3"}`. |
| `GET` | `/sessions` | Session page, most recently updated first. Query: `limit`, `cursor`, `agent`, `allAgents`, `includeArchived`, `onlyArchived`, `includeHidden`. |
| `POST` | `/sessions` | Create a Session. Body: `{workspaceDir, title?, parentSessionId?, visibility?, purpose?}`. |
| `GET` | `/sessions/<id>` | One Session. |
| `PATCH` | `/sessions/<id>` | Rename. Body: `{title}`. |
| `DELETE` | `/sessions/<id>` | Delete (falls back to archive when the Runtime has no hard delete). |
| `GET` | `/sessions/<id>/messages` | Transcript page; the first page holds the newest messages. Query: `limit`, `before`. |
| `POST` | `/sessions/<id>/prompt` | Start a turn. Body: `{content, model?}`. Answers `text/event-stream` of `TuiStreamEvent`s (`session-status`, `delta`, `message`, `done`, `error`, `end`). |
| `POST` | `/sessions/<id>/abort` | Abort the active turn. Body: `{turnId?, reason?}`. |
| `POST` | `/sessions/<id>/steer` | Steer the running turn. Body: `{content}`. |
| `GET` | `/sessions/<id>/active-run` | Active-run snapshot (`running`, `decision-blocked`, `terminal`, `idle`). |
| `GET` | `/sessions/<id>/interactions` | What needs user input: pending questionnaire, latest plan review, session permissions, active run. |
| `POST` | `/sessions/<id>/questionnaires/<requestId>/reply` | Answer a questionnaire. Body: `{answers:[{stepId, selectedOptionIds?, selectedOther?, otherText?, skipped?}]}`. |
| `POST` | `/sessions/<id>/questionnaires/<requestId>/dismiss` | Dismiss a questionnaire. |
| `GET` | `/permissions` | All pending permission requests (Runtime-wide). |
| `POST` | `/permissions/<agentName>/<requestId>/reply` | Answer a permission. Body: `{decision:"allowOnce"|"allowAlways"|"deny"}`. |
| `GET` | `/sessions/<id>/delegation` | Delegation snapshot: subagent members with `queued`/`running`/`completed`/`failed`/`stopped` status. |
| `POST` | `/sessions/<id>/delegation/stop` | Stop the delegation tree. |
| `GET` | `/sessions/<id>/background-tasks` | Background tasks owned by the Session. |
| `GET` | `/sessions/<id>/queue` | Queue snapshot (`items`, `paused`, `pendingCount`). |
| `POST` | `/sessions/<id>/queue/enqueue` | Enqueue a follow-up. Body: `{content}`. |
| `POST` | `/sessions/<id>/queue/continue` | Resume a paused queue. |
| `POST` | `/sessions/<id>/queue/steer/<itemId>` | Steer a queued item into the live turn. |
| `POST` | `/sessions/<id>/queue/delete/<itemId>` | Drop a queued item. |
| `GET` | `/sessions/<id>/usage` | Token/cost usage summary. |
| `GET` | `/sessions/<id>/context` | Context-window snapshot. |
| `GET` | `/sessions/<id>/goal` · `POST` · `PATCH` · `DELETE` | Read / create / patch / clear the session goal. |
| `GET` | `/sessions/<id>/model` · `POST` | List models for the Session / select one. Body: `{model:{providerId, modelId, variant?}}`. |
| `GET` | `/sessions/<id>/fork` · `POST` | Fork options / fork. Body: `{title?, assistantMessageId?, useSuggestedTitle?, createIsolatedWorktree?}`. |
| `POST` | `/sessions/<id>/archive` | Archive/unarchive. Body: `{archived}`. |
| `POST` | `/sessions/<id>/pin` | Pin/unpin. Body: `{pinned}`. |
| `GET` | `/sessions/<id>/rewind-preview/<userMessageId>` · `POST /sessions/<id>/rewind` | Rewind preview / rewind. Body: `{userMessageId, rewindTurnDiff?}`. |
| `GET` | `/skills` | Skill list. Query: `agent`, `keyword`, `workspaceDir`. |
| `GET` | `/mcp` | MCP server list. Query: `keyword`, `sessionId`. |
| `GET` | `/status` | Runtime diagnostics, account status, permission mode, model roster. |
| `GET` | `/events` | Runtime event stream (`text/event-stream`): `questionnaire.ask`, `permission.ask`, `session.created`, `session.queue.updated`, … One subscription per connection; `: ping` keepalives every 15 s. |

Every write endpoint beyond the core reads is capability-optional: when the
active Runtime does not expose a capability, its endpoints answer `404` with
`{"error":"<capability> is not supported by this runtime"}` rather than
failing in some other way. A client probes with `GET /` plus a `404` check.

The event stream is the mobile-client backbone: subscribe to `GET /events`
once, and a `questionnaire.ask` / `permission.ask` event is exactly the moment
a notification belongs on the phone. The per-session `interactions` probe
answers the same state on demand (poll fallback when SSE is unavailable).

```console
$ curl http://127.0.0.1:9430/
{"server":"kinetick-code-session-server","version":"0.5.3","health":"/health","sessions":"/sessions","events":"/events (SSE)","prompt":"POST /sessions/:id/prompt (SSE turn stream)"}

$ curl http://127.0.0.1:9430/sessions?limit=5
{"sessions":[{"sessionId":"mvs_4a86acbe847b4bc28567046796a1b791","agentName":"mavis","title":"Reply with the single word: pong","sessionType":"branch","sessionKind":"conversation","visibility":"visible","archived":false,"workspaceDir":"/opt/data/work/minimax-code","createdAt":1790355644115,"updatedAt":1790355644468,"status":"idle","model":{"providerId":"minimax","modelId":"MiniMax-M3","variant":"thinking"}}],"hasMore":false}

$ curl -N -X POST http://127.0.0.1:9430/sessions/mvs_4a86acbe847b4bc28567046796a1b791/prompt \
    -H 'content-type: application/json' -d '{"content":"Reply with the single word: pong"}'
event: session-status
data: {"type":"session-status","status":"started","turnId":"turn_..."}

event: delta
data: {"type":"delta","turnId":"turn_...","content":"pong"}

event: done
data: {"type":"done","turnId":"turn_..."}

event: end
data: {}
```

`/sessions` and `/sessions/<id>/messages` are pages. Session pages start with
the most recently updated Session; transcript pages start with the newest
messages and walk backwards in time, while a single page always stays in
chronological order. `hasMore` says whether another page exists, `nextCursor`
is the value to send back — as `cursor` on `/sessions`, as `before` on the
transcript — and `limit` caps the page size.

```console
$ curl "http://127.0.0.1:9430/sessions/mvs_4a86acbe847b4bc28567046796a1b791/messages?limit=10"
{"messages":[{"id":"msg-user-v1-ofKih550fY3t2XOOAD8SD5IofVGQh1cR-c4MEm4R8x4","turnId":"turn_muh7iw9x_a36jsb","role":"user","source":"api","content":"Reply with the single word: pong","timestamp":1790355644138,"actions":{"fork":false,"rewind":true}},{"id":"855ce531-5415-47c8-9732-51a8f8be9d35","turnId":"turn_muh7iw9x_a36jsb","role":"assistant","source":"api","content":"pong","timestamp":1790355644454,"finishReason":"stop","usage":{"totalTokens":14,"inputTokens":12,"outputTokens":2},"actions":{"fork":true,"rewind":false}}],"hasMore":false}
```

A page with `limit=1` on the same Session shows the pagination envelope:

```json
{"messages":[{"id":"855ce531-5415-47c8-9732-51a8f8be9d35","role":"assistant","content":"pong","finishReason":"stop","usage":{"totalTokens":14,"inputTokens":12,"outputTokens":2}}],"hasMore":true,"nextCursor":"855ce531-5415-47c8-9732-51a8f8be9d35"}
```

### Error contract

Failures answer `{"error":"<message>"}` with an HTTP status the client can
branch on:

| Status | When | Example body |
| --- | --- | --- |
| `400` | An invalid query value (`limit=zero`, `allAgents=maybe`). | `{"error":"invalid limit: zero"}` |
| `404` | Unknown Session id, or unknown path. | `{"error":"Session not found: mvs_missing"}` / `{"error":"not found"}` |
| `405` | Any non-`GET` method. | `{"error":"only GET requests are supported"}` |
| `409`, `5xx` | Runtime failures carry their transport-neutral status through (for example a queue conflict), and anything unrecognized fails closed as `500`. | `{"error":"<runtime message>"}` |

### Writing a client

A client that shows the latest Session, drives it, and reacts to input-needed
events is roughly:

```js
const base = 'http://127.0.0.1:8788';

async function get(path) {
  const response = await fetch(`${base}${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

const { sessions } = await get('/sessions?limit=20');
const session = sessions[0];
const { messages } = await get(
  `/sessions/${encodeURIComponent(session.sessionId)}/messages?limit=50`,
);
for (const message of messages) console.log(`${message.role}: ${message.content}`);

// Notifications: the event stream tells you when the agent needs a human.
const events = await fetch(`${base}/events`);
for await (const chunk of events.body) {
  const text = new TextDecoder().decode(chunk);
  if (text.includes('questionnaire.ask') || text.includes('permission.ask')) {
    console.log('user input needed');
  }
}
```

The same walkthrough from Python:

```python
import requests

base = "http://127.0.0.1:8788"
session = requests.get(f"{base}/sessions", params={"limit": 20}).json()["sessions"][0]
page = requests.get(f"{base}/sessions/{session['sessionId']}/messages",
                    params={"limit": 50}).json()
for message in page["messages"]:
    print(message["role"], message["content"])
```

To follow a long transcript, request a page, then pass `nextCursor` as `before`
while `hasMore` is true. Session ids are opaque: percent-encode them, do not
parse them.

### What the server does not do (yet)

There is no authentication, no TLS, and no origin check: any client that can
reach the bind address can read Sessions, run turns, and answer permissions.
There is no per-turn subscription endpoint that replays a turn started by
another connection (`/events` carries Runtime events, not deltas), so a second
device joining a live turn polls the transcript until it settles. Skill writes
(create/edit/delete) are not exposed; `GET /skills` is read-only.

## 4. Notes for callers

- Isolate state with `MINIMAX_DATA_DIR`; a caller gets its own config, sessions,
  and credentials rather than sharing the user's.
- Model ids are `<provider-id>/<model-id>`, and a configured provider's id is
  prefixed: `custom_provider:github-copilot/gpt-5-mini`.
- The egress guard applies to every run. A caller on a locked-down host keeps
  loopback, its configured providers, and `MCODE_ALLOWED_ORIGINS`; see
  [egress policy](egress-policy.md).
- Do not parse the human-readable `--output-format text`, and do not read
  progress from stdout there. The JSON and stream-json formats are the contract.

## 5. Verification scope

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

Recorded on 2026-09-25 (build `0.5.3`, Linux x86_64), session server, against a
data directory holding two real Sessions produced by `kcode exec` turns (a
scripted OpenAI-compatible provider on loopback):

- `--server`: boots the Runtime without the TUI, answers `/`, `/health`,
  `/sessions`, `/sessions/<id>`, and `/sessions/<id>/messages`, and exits
  cleanly within a few seconds of `SIGTERM`. Every response quoted in section 3
  is captured from that run.
- Reaching it externally: a `--host 0.0.0.0` bind accepts requests over the
  machine's LAN address, and the non-loopback warning is printed at startup.
- Error contract: the `400`/`404`/`405` bodies quoted in section 3 were
  captured live; the transport-neutral runtime status mapping is unit tested.
- CLI contract: default `127.0.0.1:8788`, explicit `--host`/`--port` forwarded,
  `--server` rejected with `--model`, `--session`, `--continue`, `--resume`,
  `--tui-mode`, and a prompt argument; invalid ports rejected at parse time.
- HTTP contract (unit tested against a scripted Runtime): query forwarding for
  both pages, transcript pages after session-id validation, `400` for invalid
  query values, `404` for unknown sessions and paths, `405` for non-`GET`, and
  the non-loopback bind warning.

Not verified for the session server: reaching a non-loopback bind from a
separate machine (the live LAN check ran from the same host), and Windows or
macOS hosts.

Not verified: Windows and macOS hosts, enterprise Copilot accounts, MCP servers
passed in `session/new`, `session/cancel` against a running turn, and clients
that advertise filesystem or terminal capabilities instead of letting the agent
run tools itself.

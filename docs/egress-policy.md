# Network egress policy

This fork ships no automatic reporting, no managed-service client, and no
metrics transport. The egress guard makes that a property of the process rather
than a consequence of which code paths happen to be reachable today: it decides
every outbound TCP connection before Node opens a socket.

Implementation: `packages/shared/src/egress-guard.ts`. Installed from
`packages/tui/src/index.ts`, before any product module is imported, by
`packages/tui/src/runtime/egress-guard.ts`.

## Why two chokepoints

No single interception point covers the codebase:

- `globalThis.fetch` is the surface used by first-party request helpers, so a
  refused call fails with a named error (`MCODE_EGRESS_BLOCKED`).
- `net.Socket.prototype.connect` is what every higher-level client ultimately
  calls, including `undici`'s own `fetch` export (which is **not**
  `globalThis.fetch`), `node:http`, `node:https`, and `node:tls`.

A refused connection is reported the way Node reports a failed one: the socket
emits `error` on the next tick and never connects. Callers observe an ordinary
connection failure, and no bytes leave the machine.

## Modes

Set `MCODE_EGRESS_MODE`:

- **`managed-deny`** (default). Loopback and ordinary endpoints stay reachable;
  the managed-service and reporting hosts below are refused.
- **`allowlist`**. Only loopback, the origins the user declared as model
  providers, and `MCODE_ALLOWED_ORIGINS` are reachable. Everything else is
  refused.
- **`off`**. No enforcement. This is an explicit opt-out and should be treated
  as a change to the data boundary.

`MCODE_ALLOWED_ORIGINS` accepts comma-separated hosts, `host:port`, or full
URLs. `MCODE_ALLOWED_ORIGINS=https://api.minimax.io` re-enables the MiniMax
model API, which is otherwise refused until a provider on that origin is
declared in the config.

## Hosts

Always refused, in every mode except `off`:

- Reporting: `data.hailuo.ai`, `data.hailuoai.com`,
  `bigdata-test.talkie-ai.com`, `bigdata-test.xingyeai.com`
- Managed services: `agent.minimax.io`, `agent.minimax.cn`,
  `agent.minimaxi.com`, `account.minimax.io`, `account.minimax.cn`,
  `platform.minimax.io`, `www.minimaxi.com`, `filecdn.minimax.chat`,
  `algeng-ali-shanghai-agent-02.oss-cn-shanghai.aliyuncs.com`

Every host in that list is a MiniMax-managed endpoint (login, managed models,
cloud tools, hub) or the Aliyun Shanghai bucket the managed file service writes
through. A third-party service does not belong there, however central it looks:
the policy is about what this fork refuses to contact, not about what it offers.

Refused unless the user declared a provider on that origin: `api.minimax.io`,
`api.minimaxi.com` — the MiniMax model API is treated as an ordinary BYOK
endpoint. Declaring it never re-opens a managed-service host.

The community provider catalog `models.dev` is an ordinary third-party endpoint,
governed by the mode like any other: reachable under the default `managed-deny`,
and refused under `allowlist` unless listed in `MCODE_ALLOWED_ORIGINS`. The
provider-preset catalog refreshes from it, and a refused refresh is isolated —
the offline snapshot shipped in `packages/local-runtime-v2/assets` keeps the
presets usable, so strict mode costs freshness, not function.

## Boundaries

- The policy matches hostnames, not resolved addresses. A caller that resolves a
  name itself and dials the IP, or that egresses through a SOCKS/TUN proxy, is
  outside its reach.
- Unix-domain sockets are local IPC and are allowed.
- IP literals are matched only against the loopback test.
- The guard is not a sandbox: it constrains where the process connects, not what
  a tool does with data once a host is allowed.

## Verification

`packages/tui/test/unit/egress-guard.test.ts` covers policy resolution, refusal
at both chokepoints, delegation of allowed traffic, end-to-end loopback traffic,
mode `off`, and uninstall. `pnpm check:egress` asserts the entry point still
installs the guard and that no reporting host appears in the built artifact.

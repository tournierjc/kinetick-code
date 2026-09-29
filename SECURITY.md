# Security

This project is a source preview. Maintainers prioritize security issues on the default branch; no support period for older versions or response SLA has been committed.

Report vulnerabilities privately by emailing [security.mcode@minimax.io](mailto:security.mcode@minimax.io). You can send reproduction details and redacted evidence directly to this address without opening a public issue first. Do not put credentials, exploit details, or real user data in public issues or community chats.

If **Security → Advisories → Report a vulnerability** is available on GitHub, you can also use that private reporting channel. If it is unavailable, use the security email above.

The release coordinator, @hetaoBackend, coordinates security triage; see [Maintainers](docs/maintainers.md). No response SLA is currently promised.

Include the affected version, operating system and Node.js version, a minimal reproduction, expected and actual permission boundaries, and necessary redacted evidence. Use synthetic files and dedicated test accounts; do not test other people's accounts or infrastructure.

## Data and service boundaries

- The active data directory stores login state, provider configuration (including API keys in `config.yaml`), and sessions. Builds from this repository default to `~/.kinetick` (or `~/.kinetick-<profile>` when a profile is selected). Older installs may still have `~/.minimax` (or `~/.mavis`); on upgrade the runtime migrates or creates a compatibility link. `KINETICK_DATA_DIR`, `MINIMAX_DATA_DIR`, or `MAVIS_DATA_DIR` can select another directory. Follow [Accounts and data](docs/installation.md#accounts-and-data) to identify it; the installer location alone does not identify stored credentials. Restrict local access to every data directory you have used and keep them out of Git, including old profiles (earlier source builds used `~/.minimax-code`). They are not shareable project configuration.
- The process installs a default-deny egress guard (see [Network egress policy](docs/egress-policy.md)): model endpoints the user configured, loopback, and `MCODE_ALLOWED_ORIGINS` stay reachable, while the MiniMax managed-service and reporting hosts are refused. This fork ships no telemetry. `MCODE_EGRESS_MODE=allowlist` is stricter; `MCODE_EGRESS_MODE=off` disables the guard and should be treated as a data-boundary change.
- Plugins, MCP servers, search, and media tools the user configures may contact external services within that policy. Those services continue to control authorization and credits; source access does not grant access to accounts or third-party resources.
- mcode-tools obtains short-lived access tokens through the host's lease broker. Never pass refresh tokens to tool processes.
- Permissions and sandboxing do not replace review of untrusted plugins, MCP servers, and shell commands. If automatic permission classification is unavailable, retain user confirmation rather than allowing operations by default.
- If credentials leak, revoke or rotate them with the service first, then remediate files and Git history. Deleting the current file does not remove historical copies.

Scan source, Git history, and build artifacts separately. A passing scan does not guarantee the absence of unknown vulnerabilities.

## Security review (29 September 2026)

Static review of the published tree at `0.6.6` (`c1afb27` on `main`). The review covered first-party packages under `packages/`, release and CI tooling under `scripts/` and `.github/`, and the product integration points in vendored `third_party/sandbox-runtime` and `third_party/pi-mono` that the runtime actually calls. It did not include a live penetration test, a full line audit of vendored upstream trees, or dynamic testing of hosted MiniMax services.

The product is a local coding agent. Its security boundary is the operating-system user that launches it. A model, a repository file, a plugin, or an MCP server can ask that user to run tools. The controls below reduce how far untrusted text can go without a person or an OS sandbox in the way. They do not make an untrusted repository safe to open with full permissions.

### Threat model

| Actor | What they can already do | What the product must still contain |
| --- | --- | --- |
| Local user running `kcode` | Read and write their own files, environment, and data directory | Keep credentials out of logs, child processes, and world-readable files |
| Other local users, or any client that can reach a published port | Connect to loopback and to any interface the process binds | Require a secret before session control, or stay on loopback and document the multi-user gap |
| Untrusted repository | `AGENTS.md`, skills, `.mcp.json`, and file contents the agent reads | Keep instructions from overriding the harness, and do not start workspace-defined processes without an explicit trust decision |
| Model, tool output, or installed plugin | Indirect prompt injection and, for plugins and stdio MCP, code execution after install or enable | Permission prompts, env stripping, and an optional filesystem sandbox |

### Findings

Severities describe impact if the stated condition is met. They are not a claim that a remote, unauthenticated attacker can reach a default install.

#### High

**H1. Session HTTP server requires a bearer token. Addressed.** `kcode --server` still serves sessions, prompts, and permission replies from `packages/tui/src/server/http.ts`, including on `127.0.0.1:8788`. Every request, including `GET /` and `GET /health`, must send `Authorization: Bearer`. A missing or wrong token is `401` and does not reach the runtime. When `--server-token` is omitted, the process generates 32 random bytes and writes them to `<data-dir>/run/session-server.token` with mode `0600` on POSIX. The startup log names that path and does not print the token. Non-loopback binds still warn. Residual risk: there is no TLS, and anyone who can read the token file or the token itself can drive the agent. ACP over stdio does not use this listener. See [Harness integration](docs/harness-integration.md).

**H2. Workspace stdio MCP requires an out-of-repo trust decision. Addressed.** `ProjectMcpRuntime.resolve` still loads `.mcp.json`, and HTTP servers still connect when discovery runs. A stdio entry stays disabled until `kcode mcp trust` records that file's digest in `<data-dir>/mcp-project-trust.json` (`packages/local-runtime-v2/src/service/mcp/project-stdio-trust.ts`). Editing the file changes the digest and stops the command until trust is repeated. Stdio children are built from the parent environment and then stripped with the same runtime-boundary list as bash Layer A, including after config and injected overlays (`packages/agent-modules/mcp/src/runtime/transport/stdio.ts`). Project config cannot expand those variable names into commands, arguments, headers, or URLs. Residual risk: a trusted stdio server is still code execution as the user, and HTTP project servers still connect without that extra trust step. User-level `mcp.json` in the data directory remains operator configuration.

**H3. Repository instructions are untrusted context. Addressed.** Workspace `AGENTS.md` is still read (32 KiB budget) and injected, but it is wrapped as `<untrusted_project_instructions>` and prefixed so the model treats it as repository content that cannot override permissions, secrets, tool policy, harness rules, or explicit user requests (`packages/local-runtime-v2/src/service/turn-system/agent-host/preparation/prompt-blocks.ts`). The same boundary is stated in the harness section of the base prompt. User settings from the data directory may change working style, and they carry the same exception. Native bash, read, write, and edit still pass through the permission engine. Residual risk: this is a prompt boundary, not a mechanical one. A model can still be steered toward a tool call the user then approves. Sandbox remains off by default, so a granted shell is a host shell.

#### Medium

**M1. Sandbox is off by default, and an enabled sandbox does not restrict the network.** `getDefaultSandboxSettings` returns `{ enabled: false, filesystemMode: 'full_access' }` (`packages/config/src/sandbox-settings.ts`). With the sandbox off, bash runs through the native shell. `compileSandboxEffectivePolicy` sets `network.enforce: false` and `allowAll: true` and comments that the desktop policy never restricts network access (`packages/local-runtime-v2/src/service/sandbox/effective-policy.ts`). Filesystem modes other than `full_access` are a real cage when the backend is up. Grep and glob spawn host `rg` and are outside that cage. Enabled-but-unready sandbox admission fails closed.

*Fix:* document the default as unsandboxed host execution, and state that an enabled sandbox is a filesystem control. If network isolation is a product promise, compile a real network policy.

**M2. TUI turns skip the shared permission engine for tools stamped `builtin` or `builtin-matrix`.** `enforceBuiltinTools` is true only for the CLI product policy (`packages/local-runtime-v2/src/service/turn-system/agent-host/native-production-dependencies.ts`). `shouldSkipPermissionCheck` then returns before `decisions.check` (`local-turn-permission-gate.ts`). Native bash, read, write, edit, grep, and glob are built with `toRuntimeTool`, which does not set `source`, so those tools still hit `LocalPermissionFacade` on the TUI. MCP tools projected as `builtin` or `builtin-matrix` do carry that source and skip the engine on the TUI. The gate comment says a desktop policy owns those tools elsewhere; this tree does not contain a second checker for them. Side-session approval still runs.

*Fix:* set `enforceBuiltinTools` for the TUI, or stamp native tools and route every catalog source through the same facade.

**M3. Filesystem permission checks are lexical.** `validatePath` uses `path.resolve` and rejects `..` segments (`packages/agent-modules/permission/src/tools/fs-permission.ts`). It does not `realpath` the target before the allow decision. A symlink inside an allowed spelling can point outside the workspace when the tool later opens it. The sandbox resolver does realpath workspace roots when the sandbox is on. Host `rg` and unsandboxed bash do not get that protection.

*Fix:* resolve existing path prefixes with `realpath` before `isPathAllowed`, matching the protected-runtime read path.

**M4. `web_fetch` blocks link-local and metadata targets, and skill archives use the public HTTPS profile. Addressed.** `LocalWebFetchClient` still accepts absolute `http:` and `https:` URLs, including documented loopback and other private intranet addresses, and it is still permission-gated (`packages/local-runtime/src/web-fetch/local-web-fetch-client.ts`). Each request and redirect hop now refuses link-local addresses (`169.254.0.0/16`, `fe80::/10`) and metadata hostnames. Remote skill archives download through `readRemoteAssetSource` (`packages/local-runtime/src/skills/remote/archive.ts`, `packages/local-runtime/src/assets/remote-source.ts`): HTTPS only, no userinfo, reserved names rejected, DNS answers must be public addresses, and the request is pinned to one of those addresses. Redirects are checked again. Residual risk: `web_fetch` does not pin DNS, so a public name can still rebind after the name check. Default egress remains a managed-host denylist; it is not a private-network firewall.

**M5. Managed access-token projections are written privately and read without a mode check.** `writeLocalRuntimeAuthContext` creates the data directory at `0o700` and the file at `0o600` (`packages/config/src/local-runtime-auth-context.ts`). `readLocalRuntimeAuthContext` loads the JSON whenever it parses. OAuth `FileStore.assertPrivatePermissions` refuses group/other access on POSIX before use (`packages/oauth-core/src/credential-store/file-store.ts`). BYOK API keys in `config.yaml` follow the write-private, read-anyway pattern. Windows skips the POSIX mode check. Content-safety requests also accept `process.env.MAVIS_ACCESS_TOKEN` when the auth context has no token (`packages/local-runtime/src/content-safety/api-v2.ts`).

*Fix:* fail closed on POSIX when `(mode & 0o077) !== 0`, and accept the environment token only behind an explicit development flag.

**M6. Plugin hooks run plugin-defined commands.** The hook runner spawns the manifest command in the workspace with a reduced environment that still includes `PATH` (`packages/agent-modules/plugin-hooks/src/runner.ts`). `shell` follows the invocation resolver. A malicious or compromised plugin is code execution on hook events. That matches a “plugins are trusted code” model only if install is an explicit trust decision.

*Fix:* show the command at install time, default `shell` off, and optionally refuse hooks unless the user enables them.

**M7. A thrown permission checker becomes an approval request.** Both engine paths catch checker exceptions and return `behavior: 'ask'` (`packages/agent-modules/permission/src/engine.ts`, `permission-core.ts`). Interactive approval then waits for the user, which is fail-closed. `auto` mode, an allow rule, or a missing distinction between “checker failed” and “needs review” can still turn a bug in the checker into an allowed call. `bypassPermissions` is a separate, explicit mode that allows tools at step 2a after the hard-deny and checker-error steps.

*Fix:* map checker exceptions to deny when the host cannot show a prompt, and keep them distinct from ordinary asks in auto mode.

**M8. Channel-bridge inbound routes do not verify platform signatures in this layer.** `POST` `telegram/inbound` normalizes the JSON body and dispatches it (`packages/local-runtime/src/channels/adapters/telegram/telegram-adapter-routes.ts`). This distribution’s public TCP server is the TUI session server, not this route. A host that mounts `/channel-bridge` on a reachable port would accept forged inbound messages unless a layer outside this function checks the webhook secret.

*Fix:* require the platform secret on the route and fail closed when it is unset.

#### Low

**L1. Skill catalog fields are interpolated into a pseudo-XML system block without escaping.** `buildSkillsBlock` inserts `name` and `description` directly (`packages/agent-modules/system-reminder/src/blocks.ts`). Plugin reference blocks in the same package use `escapeXml`. A skill frontmatter value can close the `<skill>` element and add further prompt text. The `skill` tool also returns `SKILL.md` body as ordinary tool output (`packages/agent-tools/src/desktop/local-skill.ts`).

*Fix:* escape catalog fields and wrap loaded skill bodies in the same untrusted-data envelope used for goal verification.

**L2. Interactive bash leaves user secrets in the child environment.** Layer A always strips runtime boundary keys. Layer B secret scrub defaults to `off` in interactive mode (`packages/agent-core/src/bash-subprocess-env.ts`) so tools such as `gh` and `npm` keep working. A shell the user approves can read those variables.

*Fix:* keep the default if it is intentional, and say so next to the permission prompt. Offer `scrub` as the managed default.

**L3. Short secrets stay partly visible in some masks.** Sensitive-key masking keeps the first and last four characters of longer values (`packages/local-runtime/src/api/host-helpers.ts`). Diagnostic debug sinks can record headers and bodies when enabled (`packages/shared/src/runtime-transport/debug.ts`). `PREVIEW_SECRET`, when set, is sent as a request header.

*Fix:* emit a fixed redaction token on user-visible and log surfaces, and redact credential headers in the debug sink.

**L4. HTML preview leases use a bearer token in the URL and `Access-Control-Allow-Origin: *`.** The token is 18 random bytes. Leakage of the URL grants reads under the lease root until expiry. The preview CSP allows inline script and `unsafe-eval` (`packages/local-runtime-v2/src/service/workspace/html-preview-resource.ts`).

*Fix:* bind leases to the session where the host can, and restrict CORS to the app origin.

**L5. `js-yaml` `load` is used on local config and skill frontmatter.** The dependency is js-yaml 4, whose default `load` does not construct arbitrary JavaScript types. Write paths reject `__proto__`, `constructor`, and `prototype` segments (`packages/config/src/local-model-provider-write.ts`). Many read paths do not. Impact depends on how the parsed object is later merged.

*Fix:* one safe parse helper for every untrusted YAML read, with the same key rejection used on writes.

### Controls that held up

- No `eval`, `new Function`, or `node:vm` use showed up in first-party `packages/`.
- OAuth credential files refuse group and other access on POSIX, use atomic private writes, and keep refresh material out of `auth-state.json`. The lease broker uses a random capability file, mode `0o600`, and `timingSafeEqual`.
- The MCode tools launcher clears managed access-token variables before the child starts. Bash Layer A always strips the runtime boundary set.
- CLI turns run native and builtin tools through `LocalPermissionFacade`. Bash checking includes hard blocks, pipe-to-shell patterns, and a small set of bypass-immune denies. Unknown checker failures ask rather than allow.
- Sandbox admission fails closed when the user enabled the sandbox and the backend is not ready. Vendored sandbox request filtering fails closed when that network subsystem is actually on.
- Remote asset fetch in `remote-source.ts` requires HTTPS, rejects reserved hosts, checks resolved public addresses, and pins DNS.
- Plugin archive extraction rejects symlinks and unsafe paths. MCP invoke argument parsing bounds size, depth, and prototype keys. OAuth lease frames are length-capped.
- The egress guard patches both `fetch` and `net.Socket.prototype.connect`, and `pnpm check:egress` checks that the CLI entry still installs it. `MCODE_EGRESS_MODE=off` is an explicit opt-out.
- Release CI uses read-only `contents` on most jobs, pins third-party actions to commits, installs with a frozen lockfile, and runs gitleaks on history and on the built `dist/` tree. Source inventory rejects symlinks, retired paths, and known internal-host patterns.
- The headless browser debug port and the miniapp HTTP server bind `127.0.0.1`. ACP is stdio only.

### Accepted boundaries

These are properties of the current design, not defects hidden in a single function.

- The operating-system user is the real principal. Anything they approve, any plugin they install, and any stdio MCP server they enable runs as them.
- Default egress is “block these managed hosts,” not “block the internet.” `allowlist` is the strict mode.
- `permissionMode: bypassPermissions` and `--permission full` are user-selected full access. The engine still keeps a narrow bypass-immune deny set.
- Hostname allowlisting does not see DNS rebinding, IP literals the caller dials itself, or traffic sent through an HTTP, SOCKS, or TUN proxy. The policy document already says this.
- Vendored `pi-mono` and `sandbox-runtime` remain upstream codebases. This review covered the calls the product makes into them, not every example or historical path under `third_party/`.

### Recommended order of work

1. Authenticate `kcode --server`, including the loopback case on multi-user machines (H1). Done: bearer token on every request, private token file, docs updated. TLS is still absent.
2. Stop auto-starting workspace `.mcp.json` stdio servers, and strip child environments (H2). Done: `kcode mcp trust` plus runtime-boundary stripping. HTTP project servers still connect when used.
3. Demote repository `AGENTS.md` from overriding instructions to untrusted context (H3). Done: workspace instructions are labeled untrusted and cannot override permissions, secrets, or harness rules. This remains a prompt boundary.
4. Make the sandbox default and its network behavior match what the UI claims (M1).
5. Run the TUI permission engine for builtin MCP tools (M2) and realpath filesystem checks (M3).
6. Apply the existing public-address fetch profile to `web_fetch` and skill archives (M4). Done: skill archives use the pinned public HTTPS profile. `web_fetch` still allows documented loopback and refuses link-local and metadata targets.

### Method and limits

Reviewers read the permission gate, sandbox policy compiler, session HTTP server, egress guard, OAuth and lease storage, MCP stdio and project config, plugin hook runner, web fetch, skill loading, and the CI secret-scan workflow. Searches covered command execution, dynamic code generation, YAML and archive parsing, token storage, and local listeners.

This pass did not exercise a running TUI, a live OAuth provider, or an OS sandbox kernel. It did not prove the absence of further issues in vendored code or in hosts outside this repository that mount `LocalRuntimeApiHost`. A clean gitleaks run and a clean `pnpm verify` do not close the items above.

# Verification records

## Initial repository import, 2026-09-18

The reviewed 0.4.12 CLI snapshot was imported at `c59cf5377045aa1a3e699c242d089b73b7cdc2ad` on top of the existing Kinetick Code Desktop support history. Commit `4e2e7bb5f771e9c42b2edefb1046483819b9032f` restored the Desktop image above the download links. The resulting tree ID, `327eb838c8bdc3da70d9e5f165ca6162a1d15545`, matched the reviewed source tree, and internal Git history was not imported.

Before import, `pnpm verify` passed all 14 applicable gates at implementation revision `1670bafd684ebf8dbb03dd41330ac2b099ffaf23` on macOS arm64 with Node.js 26.4.0 and pnpm 9.12.0, including 3,352 capability tests. History, exported-source, and built-distribution Gitleaks scans completed without unaddressed findings. Issue-form routing and Feishu payload generation used synthetic offline inputs and sent no notification.

Windows CI exposed fixture teardown races during preparation. The fixes drain background delivery before closing SQLite, normalize temporary paths for the Vitest runner, and require image-preview Workers to exit cleanly. These changes affect test fixtures and shutdown checks, not product behavior.

On the imported commit, the Linux and macOS Source verification jobs passed; the Windows job was cancelled by the immediate README follow-up. The follow-up passed the documentation profile and Release audit. A future source release still needs a completed final-revision platform matrix, Node compatibility run, and source candidate.

## Dependency security and unused implementation cleanup, 2026-09-18

The standalone workspace pins Vitest and its coverage package to 4.1.11, Vite to 7.3.6, Hono to 4.13.5, and Ajv's fast-uri to 3.1.6 through root overrides. The runtime uses smol-toml 1.7.1. Central overrides also cover vendored workspace development dependencies without rewriting upstream manifests. The suite launcher resolves the executable from Vitest's package manifest because the newer package no longer exports its CLI as a module subpath.

The TOML import regression runs the actual AgentImportService in a bounded child process: valid input succeeds, while comments ending unterminated arrays or inline tables are rejected. A subprocess timeout prevents a synchronous parser regression from hanging the test runner.

The unused Team cycle engine and two unreferenced adapters are removed. Legacy queue, lock and run-location modules retain the compatibility types required by shared adapters; their unused implementations are removed in place. The source inventory, package paths, lockfile and declared dependency licenses are regenerated. This change does not claim live-service acceptance or alter the repository's publication scope.

## Current source verification status

The current source target is TUI **0.4.12**, with the separate versions described in [Source status](open-source-status.md#version-and-evidence-baseline). The import results above are the current repository baseline. The 0.3.11 results below remain a historical record and have not been relabeled as current acceptance.

Fresh login/logout, cross-platform interactive acceptance, and a validated three-platform source candidate remain **NOT RUN / unavailable** for the imported revision. Add later results with their revision, environment, and scope instead of replacing the historical record.

### Source synchronization verification, 2026-09-18

The reviewed shared-source baseline is `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee` (TUI 0.4.12). The standalone projection preserves its process-local protocol and public service configuration. Desktop HTTP/generated transports, cloud handoff, private packaging, and unrelated desktop additions remain excluded.

`pnpm verify` passed all 14 gates on macOS arm64, Node.js 26.4.0 and pnpm 9.12.0: source inventory (4,210 files), generated paths (121 exports), source export, release tooling (13 tests), typecheck, build, standalone boundary, built artifacts (4 tests), capabilities (2,679 tests), status contract (9 tests), CLI/ACP smoke (7 tests), offline BYOK (1 test), permission policy (115 tests), and macOS sandbox (48 tests). The artifact checks start the packaged image-preview Worker, and the sandbox suite includes real `sandbox-exec` and Git probes.

The expanded regressions cover model effort, headless preparation cancellation and response usage, image previews, MCP naming and cancellation, background Bash, prompt/agent storage, provider discovery, and content-safety V2. Image-header fixtures are synthetic; production-request images are excluded. Secret scanning covers all Git refs, the exported source, and build artifacts; the test token uses an explicit short placeholder.

Windows/Linux execution, fresh managed-account login, real provider calls, and live content-safety V2 endpoints were not run locally. Offline BYOK fixtures do not establish live-model acceptance. This synchronization does not publish an npm release or change repository visibility.

### GitHub Copilot connector, 2026-09-19

Verification results for the provider connector added in PR #2, at code revision `e7d12152` (the documentation commit that follows changes no code).

Individual gates were run on Linux arm64 with Node.js 26.5.1 and pnpm 9.12.0: source inventory (4,163 files), generated paths (121 exports), typecheck, build, standalone boundary, egress boundary, capabilities (3,399 tests), CLI/ACP smoke (7 tests) and offline BYOK (1 test). All pass except `test:capabilities`, which reports 8 failures in `packages/tui/test/unit/update-service.test.ts` with `Unsupported KCode update host: linux-arm64`; that suite fails identically on an unmodified `origin/main` worktree in the same environment and does not fail on any CI platform.

GitHub Actions passed Source verification on ubuntu-latest, macos-latest and windows-latest (Node.js 24), the `verification` aggregate, and the Release audit.

The connector adds 61 tests: 23 for the sign-in manager, 18 for the catalog reader, 3 for the composition, 1 for the per-model API override, 9 for the TUI sign-in panel, 6 for the `/provider` row and its snapshot, and 1 for the `/model` entry in the existing feature-flow suite. The discovery tests run against a captured `/models` response; their values are the API's, but they are not live-service acceptance. Live calls were made outside CI with a real account: completions on `openai-responses`, `anthropic-messages` and `openai-completions`, and `kcode exec` end to end on all three protocols and in all four egress modes (`managed-deny`, explicit `managed-deny`, `allowlist`, `off`). The TUI panel is covered by unit tests only: an interactive device-flow sign-in in a real terminal, enterprise-account hosts, and credential removal through provider management were not run.

### Fork update channel, 2026-09-23

Verification results for the fork update source added in PR #40 at revision `8b41098` (the documentation commit that follows changes no code).

Individual gates were run on Linux arm64 with Node.js 26.5.1 and pnpm 9.12.0: source inventory (4,233 files), generated paths (127 package exports), typecheck, build, standalone boundary, egress boundary, release tooling, built artifacts, status contract, CLI/ACP smoke, offline BYOK, and permission policy. `test:capabilities` reports the same 8 `packages/tui/test/unit/update-service.test.ts` failures with `Unsupported KCode update host: linux-arm64` that an unmodified `origin/main` worktree reports in this environment; no CI platform fails them.

The new source is covered by 18 cases in `packages/tui/test/unit/update-fork-release.test.ts` — release selection per channel, checksum parsing, size and digest verification, one install command per owning package manager, and the download/verify/install path with its refusals — plus 6 routing cases in `update-application.test.ts` (fork channel routing, the manual command for a source checkout, the fallback to the releases page, the refusal of the upstream installer's prefix layout, the registry opt-in, and the managed channel). The pre-existing application cases cover the upstream registry and installer paths, which a fork installation now reaches only through `KCODE_UPDATE_SOURCE=upstream`; they state that opt-in explicitly.

The channel was read back against the live repository: `https://api.github.com/repos/tournierjc/kinetick-code/releases` resolves to `v0.5.2-fork.1`, whose archive `minimax-code-0.5.2-fork.1.tar.gz` (13,144,451 bytes — the pre-rename asset name, addressed through its public download URL) matches its published `.sha256`, and no stable release is published, so the `stable` channel reports that it has no release to install instead of installing anything.

Not run: an actual upgrade of an installed CLI (no installation is replaced on this machine), the Windows refusal path on Windows, and an update through a proxy. The archive and its checksum come from the same release over TLS, so the updater proves integrity and provenance-by-access-control, not authorship: the fork publishes no signed manifest, unlike the upstream managed channel.

### Single release model, 2026-09-23

Verification results for the update-module consolidation at revision `78d2b5a` (the code commit this documentation commit follows).

`kcode update` carries one release model and one channel again. `packages/tui/src/update/release.ts` is that model: it resolves this repository's GitHub Releases through `api.github.com`, verifies the archive against the published size and `.sha256`, and installs it with the package manager that owns the running installation. The upstream signed CDN channel (`update/service.ts`, its manifest and signature model, `McodeUpdateService`), the npm-prefix staging module (`update/versioned-prefix.ts`), the upstream npm registry path (dist tags, `@minimax-ai/code` version lookups, the package-manager command builders and the `__TUI_NPM_DIST_TAG__` define) and the `KCODE_UPDATE_SOURCE=upstream` routing are removed, together with the separate `fork-release.ts` module the release module replaced. `prefix-update.ts` remains for the startup path that schedules a pending update an older installation left in its prefix.

Individual gates were run on Linux arm64 with Node.js 26.5.1 and pnpm 9.12.0: source inventory (4,232 files), generated paths (127 package exports), typecheck, build, standalone boundary, egress boundary, release tooling, built artifacts, status contract, CLI/ACP smoke, offline BYOK, permission policy, and capabilities — 171 files, 4,561 tests passed, 15 skipped, none failed. The eight `Unsupported KCode update host: linux-arm64` failures this environment used to report came from `update-service.test.ts`, which disappears with the channel it tested, so the full suite is green on arm64 here for the first time.

Coverage: 24 cases in `packages/tui/test/unit/update-release.test.ts` (release selection per channel and pinned version, pre-rename archive-name compatibility, checksum parsing, size and digest verification, one install command per owning package manager, channel configuration read from `update.json`, download/verify/install with its refusals, Windows refusal, cancellation, and version ordering) and 73 cases in `update-application.test.ts` (install-source classification and detection ordering, installer receipts, install-root and managed-receipt resolution, the prefix journal, plan mapping per installation layout with the artifact URL, refusals for the two upstream-installer layouts, apply delegation with its progress options, and channel labelling).

Not run: an actual upgrade of an installed CLI (no installation is replaced on this machine), the Windows refusal path on Windows, and an update through a proxy. The live channel read-back in the previous entry still applies — the API and asset URLs are unchanged.

### Release-preparation verification, 2026-09-12

`pnpm verify` was run on `3de31f0e365e635c52d661c0a14c9ee69e65f099` in an isolated worktree after a frozen-lockfile install, on macOS arm64 with Node.js 26.4.0 and pnpm 9.12.0.

| Gate | Result |
| --- | --- |
| Source inventory, workspace exports and native helper integrity | PASS: 4,096 reviewed files |
| Generated TypeScript paths | PASS: 119 exports |
| History-free source export | PASS |
| Release tooling | PASS: 13 tests |
| Full typecheck | FAIL: `packages/tui/src/cli/network-proxy.ts:134`, TS2724; installed Undici 8 exposes `Dispatcher.DispatchHandler`, while the source references `Dispatcher.DispatchHandlers` |
| Build, standalone checks, artifact/capability/status/smoke/BYOK/policy/sandbox tests | NOT RUN: the full verifier stopped at typecheck |

The failing source file and dependency lockfile are unchanged from the reviewed base `edbd4bd483f9326fae14bed6852950f371d4feab`. At that revision, the preparation changed release metadata, attribution and contributor documentation without repairing the runtime/dependency mismatch. The follow-up below resolves it. A documentation-profile pass must not be substituted for full current-source acceptance.

### Merge-review follow-up, 2026-09-12

Commit `67ad241fb201c618bdedfba5998f7a6fb6f1d0cf` updates the proxy dispatcher's handler annotation to `Dispatcher.DispatchHandler`, matching Undici 8's installed `dispatch` signature. It forwards the handler unchanged and changes no runtime behavior.

On that commit, `pnpm verify` **passed all 14 applicable gates** on macOS arm64, Node.js 26.4.0, pnpm 9.12.0: source checks, generated paths, history-free export, release tooling, typecheck, build, standalone checks, artifact/capability/status/smoke/BYOK/policy/sandbox tests. The capability suite passed 412 tests; the existing real macOS sandbox probes also passed. Local Gitleaks scans of complete Git history, the committed source snapshot and the built distribution reported no findings with the reviewed `.gitleaks.toml` rules.

This resolves the local typecheck failure recorded above. It does not establish Windows/Linux acceptance, successful GitHub Actions runs, a three-platform source candidate or fresh live-service acceptance. Release prerequisites remain separate from this local verification result.

## Historical TUI 0.3.11 acceptance

Verification date: 2026-09-11. Environment: macOS arm64, Node.js 26.4.0, pnpm 9.12.0. Capability baseline: TUI 0.3.11.

This record preserves the clean-directory baseline from managed-capability restoration and adds private release review evidence. Passing tests do not mean all online services have passed acceptance; live evidence appears below and in `release-audit.md`.

## Clean-directory acceptance

Final source was copied outside the repository without `.git`, `node_modules`, `dist`, or `.cache`. A new pnpm store and public npm only were used for a frozen-lockfile install. The build downloaded the pinned KCode package again and extracted mcode-tools without reusing development artifacts.

| Check | Result |
| --- | --- |
| Cold install from public npm | Passed, approximately 1 minute 15 seconds |
| Source inventory, internal references, workspace exports, native helper integrity | Passed, 3979 files at this baseline |
| TypeScript check of the complete entry point | Passed |
| Standalone build and dependency boundaries | Passed; key managed capabilities remained in the output |
| Login, leases, accounts, plugins, connectors, feedback, updates, ACP, Matrix configuration | 21 explicitly selected test files; 321 tests passed |
| Original mcode-tools archive / file hashes, tamper rejection, actual CLI startup | 3 passed |
| CLI, providers, SQLite, ACP initialization, internal-switch rejection, offline local plugins | 7 passed |
| BYOK, session resume, actual file tools, managed-model authentication gate | 1 passed |
| Existing permission facade | 115 passed |
| Vela status protocol | 9 passed |
| Sandbox, executable resolution, actual macOS file / Git probes | 48 passed |

**504 automated tests passed** in total, with relevant validation completed in both development and clean directories.

The BYOK test uses a local OpenAI-format protocol server to drive the actual runtime. It verifies authorization headers, resume history, and real file contents in subsequent model requests, while ensuring Token Plan model overrides still require login. It does not establish real provider quality or production availability.

After managed capabilities were restored, startup could request the model catalog and telemetry. Offline tests return local 503 responses for an explicit public-service allowlist, recording attempts without sending them. Unknown addresses and unexpected TCP connections still fail tests. This verifies some unavailable-service behavior; those failures are not counted as live-service successes.

## Real TUI inspection

A real PTY with an isolated data directory and the network guard confirmed:

- Welcome shows Token Plan as unauthenticated.
- `/provider` presents both MiniMax OAuth / Token Plan and API key options.
- `/login` opens a cancellable China / international region selector.
- `/plugins` shows a clear error for an injected 503. Successful loading and source switching have component / application coverage; this manual check did not connect successfully to the official marketplace.
- `/exit` exits normally and restores terminal state.

That offline PTY check did not open a browser or call a real model. Subsequent online acceptance with an existing account is recorded separately below.

## Private release preparation additions

- Three tests cover source synchronization candidates, preservation of public changes, conflicts, and unsafe-output rejection. A no-change comparison against the actual baseline reported zero changes.
- Full-history, source-snapshot, and build-artifact Gitleaks scans were added. GitHub `Release audit` passed; see `release-audit.md` for false-positive handling and case sanitization.
- Initial Windows CI exposed Git CRLF conversion affecting native helper hashes. `.gitattributes` now pins LF. Later fixes addressed POSIX temporary paths, mock install layouts, and cmd quoting in tests. The relevant 70 tests passed locally; use PR checks for final platform results.
- At that time, GitHub ran macOS / Windows / Linux × Node.js 22 / 24. Each job included frozen install, source checks, source export, build, boundaries, tool artifacts, the 321-case capability suite, status protocol, smoke, and BYOK. Type checking ran once in the Linux / Node.js 22 full profile; the other five jobs used the platform profile, omitting only that compiler gate. Windows skipped one POSIX-only capability case. Permission facade tests ran outside Windows; actual sandbox probes ran on macOS. GitHub runner success did not constitute an interactive user-path check on each physical platform.

## Live production-account acceptance

Using the user-authorized existing login and dedicated temporary workspaces, the following were confirmed:

- A Token Plan MiniMax-M3 session succeeded; resume recovered the previous marker.
- BYOK provider connectivity and a real model session succeeded.
- Events confirmed a successful actual `web_search` call. A separate response that returned a URL without calling the tool was not counted.
- The official plugin marketplace returned 54 available plugins.
- Real bash → mcode-tools → host-lease authentication succeeded. Connector discovery returned 13 tools with no provider failures.

Actual service responses, credentials, and local account paths were not committed. The recorded acceptance results summarize sessions run with synthetic inputs; they do not claim business calls for every plugin or generation tool.

## Not yet verified

- Fresh browser login / logout, full membership quota and billing validation, paid media generation, website deployment, new third-party connector grants / business writes, and feedback / diagnostic uploads.
- Interactive TUI user paths on Windows and Linux; GitHub runner builds and tests are recorded separately.
- Actual update installation / upgrade; the development machine's global installation was not changed.
- Real task quality for each bundled skill, and Desktop features outside the original TUI's defaults.

This historical acceptance did not publish the GitHub source repository or an npm package. The official npm product has a separate release history; its currently verified version is listed in [Source status](open-source-status.md). TypeScript remains strict; `noUncheckedIndexedAccess` and `noImplicitOverride` retain the vendored libraries' existing compatibility settings.

## Windows timeout investigation, 2026-09-12

On commit `4e7582c`, the Windows / Node.js 22 BYOK fixture exceeded its 35-second child-process deadline; the other six CI checks passed. The original failure reported only `Timed out: exec`, without the command phase or captured output, so it does not establish whether execution or process shutdown stalled.

The fixture now records per-command duration, bounded stdout / stderr and execution progress on timeout, plus an opt-in unreferenced process-resource probe. It waits for child `close` before reading complete output, and force-terminates timed-out children before cleanup. The 35-second deadline, 90-second overall bound, default text output, and BYOK / resume / actual-file assertions remain. No runtime behavior or timeout was relaxed. Use the latest PR run for the result; a passing follow-up does not by itself explain the earlier timeout.

# Source status

The current source target is **TUI 0.4.12**. This repository contains the terminal TUI, headless CLI, ACP implementation, and the public distribution tooling around them.

## Version and evidence baseline

| Concern | Current value | Source of truth |
| --- | --- | --- |
| TUI capability version | 0.4.12 | `packages/tui/package.json` |
| Root workspace version | 0.4.12, aligned with the TUI | Root `package.json` |
| Published npm observation | `@minimax-ai/code@0.4.12`; npm `latest` was 0.4.12 on 2026-09-18 | Public npm registry |
| Shared-source baseline | `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee` | `release/extraction.json` |
| Embedded mcode-tools | 0.0.4, extracted from public `@minimax-ai/code@0.3.11` | `scripts/lib/mcode-tools-artifact.mjs` |
| Historical live-service acceptance and demo | TUI 0.3.11, recorded 2026-09-11 | `docs/verification.md`, `docs/release-audit.md`, `docs/demo.md` |

The product, TUI, and root workspace use the same 0.4.12 version. The embedded tool has its own version. Workspace and local-build manifests remain `private: true` to prevent accidental npm publication. Matching version strings do not prove that this source tree reproduces the published npm tarball.

## Source boundary

- MiniMax OAuth and Token Plan, BYOK, accounts, quota views, the official plugin marketplace, managed connectors, search, mcode-tools, updates, feedback, and bounded diagnostic clients are included.
- The in-process runtime, public workspace dependencies, tools, and sandbox are included. Internal generated IDL, the Desktop HTTP front door, and cloud-executor-only implementations are excluded.
- mcode-tools is extracted from a pinned public npm package with archive and file-hash verification. Only the host holds refresh tokens.
- Source checks permit reviewed public service API paths while rejecting internal addresses, generated protocols, and obvious credentials.
- Internal Git history stays outside this repository. Shared-source updates use the reviewed process in [Source synchronization](source-sync.md).

See [TUI capability coverage](tui-capabilities.md) for individual features, [Verification records](verification.md) for evidence, and [Publication scope](publication-authorization.md) for the repository boundary.

## Product identity

The fork ships as **Kinetick Code** with the `kcode` command, the `KINETICK CODE` welcome wordmark, and
`kinetick-code-*` release and source-archive names. Documentation, the CLI/TUI/ACP display strings, the
OpenRouter app-attribution header, and the release tooling carry that identity. Internal names follow the
same rename: TypeScript identifiers (`Kcode*`, `KCODE_*`), the workspace package names (`@mavis/code`,
`kinetick-code` at the repository root), and the strings this build writes into user files
(`# Added by Kinetick Code`, `# Managed by Kinetick Code`, `process.title = 'kinetick-code'`).

These spellings are deliberately unchanged, and the product rename does not alter them:

- `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` keep the upstream attribution text.
- The ACP extension namespace and method names (`minimax-code/extensions`, `mcode/session/*`), the
  `minimax-code-login` authentication-method id, and the ACP agent `name` are the wire contract that ACP
  clients already implement.
- Account device-flow client fields (`device_platform`/`browser_name`/`client`: `mcode`), the reported
  `Client  mcode <version>` identity in feedback diagnostics, and the remote-control headers (`X-MCode-*`)
  belong to MiniMax service contracts.
- Update-channel values (`product: minimax-code`, `updateOwner: mcode-installer`) and the `mcode` launcher
  names the prefix updater looks for identify installs created by the upstream installer. They are read to
  recognize such an installation, not to follow its channel: an installation whose `install.json` carries
  that identity is not replaced in place, and every installation this build owns — an archive install or a
  global npm/pnpm/yarn/bun install — updates from this repository's GitHub Releases (see
  [Updating](installation.md#updating)).
- Data locations (`v2/mcode/drafts`, `v2/observability/mcode`, `.minimax*`, `.mcode`) and environment
  variables (`MINIMAX_*`, `MCODE_*`) are persisted user state; renaming them would orphan existing
  drafts, logs, and configuration. The same reasoning keeps the `.mcode-update-*` files the updater leaves
  in an install prefix. The path marker and the `rm`-shim header do carry the fork name now
  (`# Added by Kinetick Code`, `# Managed by Kinetick Code`); the spellings earlier releases wrote are
  still recognized so an existing managed block in a user's shell profile is never duplicated and an older
  shim is rewritten in place on the next startup.
- `@minimax-ai/code` stays the installed package identity the release archives are published under: it is
  what `kcode update` and the install-source detection resolve a running installation against, and
  installing the archive into the same npm prefix replaces an existing `@minimax-ai/code` installation in
  place instead of leaving two products on disk. `@minimax/mcode-sandbox-runtime` is an upstream dependency
  pinned in `packages/local-runtime-v2`. A workspace install made before this rename (`@minimax/code`) is
  still recognized as an internal installation.
- The bundled runtime prompts and agent assets (including the `kinetick-code-product` skill) are upstream
  product material that states its own ownership; changing them is a runtime-content change, not a
  documentation rename. The vendored `third_party/**` packages keep their own notices and identifications
  for the same reason, and the recorded demo assets and the local CHANGELOG entries describing earlier
  releases keep their provenance from the version that produced them.
- `mcode-tools` and its `@minimax/*` package names, plus the plugin manifest key `mcode`, are separate
  feature and manifest contracts. The `--harness minimax-code` argument the performance driver passes is a
  workload name the external benchmark harness recognizes, and the two issue-automation workflows
  (`label-issue-product`, `sync-issue-to-feishu`) stay guarded on the upstream repository, so they remain
  inert here.

## Repository baseline

The initial CLI source snapshot was imported into `MiniMax-AI/minimax-code` on 2026-09-18 at commit `c59cf5377045aa1a3e699c242d089b73b7cdc2ad`. Commit `4e2e7bb5f771e9c42b2edefb1046483819b9032f` restored the Desktop image above the download links. The import preserved the repository's Desktop issue history and support workflow while adding the CLI source without internal Git history.

Open dependency upgrades remain separate changes and require their own review and validation. Current test results and untested service boundaries are recorded in [Verification records](verification.md).

# Releasing MiniMax Code

## Fork release process (tournierjc/minimax-code)

This repository is a private fork. Its release channel is **GitHub Releases on
`tournierjc/minimax-code` only**. Nothing else on the MiniMax side — the npm package
`@minimax-ai/code`, the `filecdn.minimax.chat` installers, the `agent.minimax.io`
site, or the desktop app — is built from this fork, and no fork release may publish
to any of them. The repository's `package.json` and TUI manifests stay
`private: true`; the release workflow publishes a GitHub release asset, never an
npm package.

A fork release is a normal upstream-style CLI release (below) plus fork rules:

1. **Prerequisite — synchronization settled.** Do not cut a release while an
   upstream synchronization PR (`merge/upstream-*` head, or a sync-branded PR) is
   open, unless you are deliberately releasing without that pending sync. State
   the last upstream revision carried (from `release/extraction.json`
   `sourceRevision`, cross-checked against `upstream/main`) in the release notes.
2. **Fork invariants must be green, not just CI.** Before releasing, confirm the
   telemetry subsystem is still absent (`docs/telemetry.md` deleted, no
   `requireTelemetryRunner` reference) and the default-deny egress guard is
   installed from the CLI entry. `pnpm check:egress` covers the guard. A release
   that would re-introduce an outbound reporting path is blocked by definition.
3. **Branch/PR discipline.** Release via `pnpm release:cli` (below): it branches,
   bumps both manifests, tags, and pushes atomically, then opens a version PR back
   to `main`. Never push `main` directly and never move a distributed tag.
   `gh` must be authenticated as the fork owner (`gh auth status`); pushes go
   through the gh git-credential helper — no tokens embedded in remotes.
4. **Version numbering.** Every fork release carries the `-fork.N` prerelease
   suffix: tag `v<X.Y.Z>-fork.N`, where `X.Y.Z` is the upstream core the merged
   tree is based on and `N` increments per fork release on that core
   (`v0.5.1-fork.1`, then `v0.5.1-fork.2`; upstream 0.5.2 sync restarts at
   `v0.5.2-fork.1`). The fork tree always differs from upstream at any given
   core — the egress guard, telemetry removal, and fork docs are fork-only — so
   a bare upstream number is never valid here. A `-fork.N` tag creates a GitHub
   *prerelease* and the release tooling accepts it; the bare `v<X.Y.Z>` form is
   reserved for a deliberate stable promotion without fork-only changes.
   Never reuse an upstream version number for a tree that differs from upstream
   at that version.
5. **CI and publication.** The tag triggers the `CLI release` workflow: full
   `pnpm verify` + gitleaks scans, one `minimax-code-X.Y.Z.tar.gz` archive, then
   install validation on Linux and macOS (Node 22.19.0, 24.2.0, 25, 26). Only if
   every install passes, a GitHub Release with the archive and `.sha256` is
   created on this fork. Windows validation remains paused upstream-wide.
6. **Post-release read-back.** After CI publishes, record: tag, commit SHA,
   upstream `sourceRevision` carried, archive SHA-256, which live-service checks
   were NOT RUN, and the release URL. Merge the version PR so `main` carries the
   released version before the next release or the next upstream sync.
7. **Installation docs.** The fork README and
   [installation guide](installation.md#install-a-github-release-archive) are the
   authoritative install instructions for this fork. Upstream installer/npm
   commands that appear in mirrored docs are labeled as upstream-product-only;
   keep those labels when re-syncing docs.

Rollback: a released tag is immutable. To retract a bad release, unlist the GitHub
Release and publish a new patch version; do not move or delete the tag.

## Tag-triggered CLI installation packages

Run the release command from a clean checkout of the latest reviewed `origin/main`.
Git and an authenticated `gh-axi` or `gh` are required:

```bash
pnpm release:cli --version 0.4.13 --dry-run
pnpm release:cli --version 0.4.13
```

The dry run checks the starting revision, versions and remote refs without changing
files, creating commits or pushing. The release command then:

1. Creates `release/v0.4.13` from the reviewed starting commit.
2. Bumps `package.json` and `packages/tui/package.json` together and commits them.
3. Creates the annotated `v0.4.13` tag on that version commit.
4. Atomically pushes the release branch and tag, without pushing `main`.
5. Opens a version PR back to `main`; merge it through the normal review process.

CI requires the tag, both committed source versions and `mcode --version` to agree.
It does not override the source version during a build. An existing tag or release
branch, a non-increasing version, uncommitted files, or a starting commit other
than the latest `origin/main` stops the command before version changes.

The tag starts the release workflow independently of the version PR. If a network
or PR-creation failure occurs, inspect the local and remote branch/tag before
retrying: the version commit and tag are retained for recovery. If both refs were
pushed but opening the PR failed, open that version PR manually. Never delete and
recreate an already distributed tag. Merge the version PR before starting the
next release so `main` carries the released version.

The workflow runs the full verification profile and secret scans, builds one
`minimax-code-X.Y.Z.tar.gz` npm installation package, and authenticates and installs
that same archive on Linux and macOS with Node 22.19.0, 24.2.0, 25 and 26. Each
installation checks the generated `mcode` launcher, native SQLite, ripgrep, and
the offline smoke/BYOK suites. Windows validation remains paused.

Only after every installation succeeds does CI create a GitHub Release with the
archive and its `.sha256` checksum. Tags such as `v0.4.13-rc.1` create prereleases.
Release creation starts as a draft; assets are uploaded before it becomes public.
Existing releases are never overwritten. If publication fails after draft
creation, inspect the draft and workflow artifacts before deciding whether to
finish publication manually or delete only the incomplete draft and rerun.
Never move an already distributed tag to different code.

To exercise this workflow without publication, dispatch `CLI release` on a
selected branch. An optional tag input must match the committed source version. A manual dispatch only builds and
validates Actions artifacts, even when the requested tag already exists.
PRs that change release tooling also run the build/install matrix using the
committed source version, without creating a tag or publishing a release.

To reproduce the packaging and installation checks locally, use a clean reviewed
commit and keep output outside the repository:

```bash
export MCODE_RELEASE_TAG="v$(node -p 'require("./package.json").version')"
pnpm verify
node scripts/package-cli-release.mjs "$MCODE_RELEASE_TAG" /tmp/mcode-release
MCODE_RELEASE_ARCHIVE="/tmp/mcode-release/minimax-code-${MCODE_RELEASE_TAG#v}.tar.gz" pnpm verify --profile package
```

The `package` profile validates installation of an existing archive; it does not
replace full source verification. The archive includes the compiled CLI, runtime
assets, licenses and a `release.json` source receipt. npm installs external runtime
dependencies, including native dependencies, for the user's platform. It does not
include Node.js and is not an offline bundle. See [installation](installation.md#install-a-github-release-archive).
This workflow does not publish to the npm registry or change the official installer.

## Source previews

The current source target is MiniMax Code 0.4.12. Workspace and local-build manifests remain `private: true` to prevent accidental npm publication. A source release, npm package, and installer are separate artifacts with separate verification.

## Prepare a release

1. Select a reviewed commit on `main`. For shared-source updates, first complete the three-way process in [Source synchronization](source-sync.md).
2. Review every added, changed, and removed file. Confirm that `release/public-source.json`, package licenses, `LICENSE`, `NOTICE`, and third-party notices match the selected tree.
3. Run `pnpm verify` from a clean checkout. Require successful final-revision Source verification and Release audit checks.
4. Dispatch `Node compatibility` and `Source candidate` on the selected revision. Match each run to the immutable commit SHA and wait for every required platform result.
5. Use temporary projects and synthetic inputs for any live-service checks. Record unavailable accounts or grants as NOT RUN. Confirm costs and upload scope before testing paid media, deployment, feedback, or diagnostics.
6. Record the source commit, archive SHA-256, inventory digest, verification results, reviewer, and known limits. Keep scan reports, account data, and private review material outside the repository.

Before npm or installer distribution, separately validate the published package name and version, update behavior, native dependencies, installation scripts, and bundled license texts. Source verification does not cover those release channels.

## Automated source candidates

The `Source candidate` workflow exports the selected commit without Git history, verifies its receipt, and scans both repository history and the extracted source. Linux and macOS runners authenticate the same archive, install from public npm into fresh stores, and run the archive verification profile.

Windows full validation is temporarily paused for Node compatibility and source candidates. Ordinary pull requests run a focused Windows source-verification contract, but candidate reports still cover only Linux and macOS; a successful candidate does not establish Windows acceptance. Restore the Windows compatibility/source-candidate matrices and the required report set in `scripts/source-candidate.mjs` together when those checks are reliable again.

After both platform jobs pass, the workflow creates a `source-candidate-<full-SHA>` artifact containing:

- `minimax-code-source.tar.gz`
- The archive receipt and SHA-256 file
- `candidate.json` with the revision and platform summary
- Per-platform verification reports

The intermediate `unverified-source-<full-SHA>` artifact is not a release candidate. Candidate generation does not create a GitHub Release, publish to npm, or update an installer.

## Publish and read back

1. Create a prerelease tag and release notes for the verified public commit.
2. Attach the authenticated source archive and checksum. Do not attach a local `dist` directory or user profile as a cross-platform artifact.
3. State the source version, installation paths, included interfaces, known limits, and any live-service checks that were not run.
4. Read back the tag, commit, archive digest, documentation links, and release notes after publication.

## Initial repository import

The initial CLI source snapshot was imported on 2026-09-18 at `c59cf5377045aa1a3e699c242d089b73b7cdc2ad`, on top of the existing MiniMax Code Desktop support history. The follow-up commit `4e2e7bb5f771e9c42b2edefb1046483819b9032f` restored the Desktop image. The import kept the existing issue forms and Feishu support workflow, used `README_ZH.md` as the Chinese entry point, and excluded internal Git history.

`release/extraction.json` remains the shared-source baseline. Future updates arrive through reviewed synchronization PRs; the initial import is not repeated.

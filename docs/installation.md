# Installation packages and source builds

> [!IMPORTANT]
> This repository is [`tournierjc/kinetick-code`](https://github.com/tournierjc/kinetick-code) (Kinetick Code).
> Install from its [GitHub Releases](https://github.com/tournierjc/kinetick-code/releases) or build from this
> source. Upstream MiniMax installers and the public `@minimax-ai/code` npm package deliver **upstream** builds
> without these changes — they are not the install path for Kinetick Code. See
> [Release process](releasing.md#fork-release-process-tournierjckinetick-code).

## Install a GitHub release archive

When a CLI release is available on the fork's [GitHub Releases](https://github.com/tournierjc/kinetick-code/releases),
download `kinetick-code-X.Y.Z.tar.gz` and the matching `.sha256` file. This is an npm
installation package containing the built CLI; no source build or pnpm is needed.
Install Node.js 22.19+ (22.x), 24.2+ (24.x), 25 or 26 first. npm still needs network
access to public npm for runtime dependencies. Native dependencies can require
Python and C/C++ build tools when no matching prebuilt binary is available.

For example, for an available `vX.Y.Z` release:

```bash
# Linux; on macOS use: shasum -a 256 -c kinetick-code-X.Y.Z.tar.gz.sha256
sha256sum -c kinetick-code-X.Y.Z.tar.gz.sha256
npm install --global ./kinetick-code-X.Y.Z.tar.gz --registry=https://registry.npmjs.org/ --include=optional --ignore-scripts=false --allow-scripts=better-sqlite3
kcode --version
```

Keep optional dependencies enabled and allow the native SQLite installation
script. The tag determines the installed version. GitHub archive installation is
validated on Linux and macOS; Windows package acceptance is currently not run.

This archive installs under its own package name, `kinetick-code`, provides the
`kcode` command and uses the same default user data directory as the official npm
CLI. Update to another GitHub version either by explicitly installing its archive
or by running `kcode update`, which selects this fork's releases (see
[Updating](#updating)). To remove the package, use
`npm uninstall --global kinetick-code`. User data remains in place.

Fork release archives are named `kinetick-code-X.Y.Z.tar.gz` (the version matches
the tag, see [Release process](releasing.md#fork-release-process-tournierjckinetick-code)); verify and
install them the same way as the example above.

If an older global package named `@minimax-ai/code` is still on the same npm prefix, remove it with
`npm uninstall --global @minimax-ai/code` after installing `kinetick-code`, then confirm with
`command -v kcode`. The updater recognizes both package names.

## Updating

`kcode update` installs the newest release published on this fork's
[GitHub Releases](https://github.com/tournierjc/kinetick-code/releases). It resolves the release through
`https://api.github.com/repos/tournierjc/kinetick-code/releases`, downloads
`kinetick-code-<version>.tar.gz` and its `.sha256`, and refuses to install anything whose size or
checksum differs from the published values. The verified archive is then installed with the package
manager that owns the running installation (`npm`, `pnpm`, `yarn`, or `bun`). Restart the CLI to use
the installed version.

- The `preview` channel is the default and takes every published release, including a prerelease
  tag if one is ever cut. Set `"channel": "stable"` in `update.json` inside the install data
  directory to skip GitHub prereleases and follow plain releases only.
- A source checkout has no package manager to update. `kcode update` prints the exact
  `npm install --global <archive>` command for the newest release instead of running it.
- Installing an archive never moves or migrates an existing installation: where this product was
  installed under an earlier package name (`@minimax-ai/code`), the new `kinetick-code` package is
  added beside it and the previous one stays until it is removed with
  `npm uninstall --global @minimax-ai/code`. User data, provider configuration and sessions are
  unaffected, because the data directory is unchanged.
- An installation the upstream installer owns is not replaced in place. That is either a data root
  carrying the installer's `install.json` receipt (`product: minimax-code`, `updateOwner:
  mcode-installer`) or an npm prefix carrying the installer's versioned layout (receipt,
  `.minimax-code` package root, launcher pairs). Its launcher, receipts and metadata describe the
  upstream product, and the versioned launcher would keep pointing at the release it already runs, so
  `kcode update` says so and stops instead of half-replacing it. Install a fork archive with
  `npm install --global`, or keep that installation on the distribution it came from.
- Updating needs network access to the repository (`api.github.com`, `github.com`,
  `objects.githubusercontent.com`) and to public npm for runtime dependencies. Under
  `MCODE_EGRESS_MODE=allowlist` these hosts must be declared in `MCODE_ALLOWED_ORIGINS`, otherwise the
  update fails closed.
- Windows installations are refused: this fork's release workflow validates package archives on Linux
  and macOS only. Install the archive by hand on Windows.
- What the check proves: the archive matches the checksum published beside it in the same release, over
  TLS, from the repository above — the same assurance as verifying a download by hand. The fork
  publishes no signed manifest, so the updater cannot prove authorship beyond access control on that
  repository and its releases.

## Install from source

Kinetick Code is not published as a public npm package under its own name for day-to-day installs; use a
[GitHub release archive](#install-a-github-release-archive) or build from this source. Upstream MiniMax
channels (`@minimax-ai/code`, one-command installers) are not this product.

Workspace/local build manifests remain `private: true` to prevent accidental publishing. A source
checkout may contain additional reviewed distribution changes; matching version strings alone do not
establish byte-for-byte equivalence with any published tarball. Use the committed source revision and
release receipt to identify a source build.

For a source build, you need Git, Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26, and pnpm 9.12.0. Regular CI uses Node.js 24 across Linux and macOS. The weekly and manual compatibility matrix covers Node.js 22.19.0, 24.2.0, 25, and 26 on both platforms. Windows CI and source-candidate validation are temporarily paused while their checks are made reliable. Initial installation and build require access to public npm.

On Windows, check out this repository on a local NTFS volume before running `pnpm install`. The repository uses pnpm workspace links for vendored packages, and those links require NTFS junctions. FAT32/exFAT volumes, network shares, and other non-local Windows volumes cannot create the required junctions. The preflight command below verifies the volume and stops with a clear message before pnpm creates workspace links; run it immediately before `pnpm install`. A local NTFS volume can still contain a cloud-synced folder, which the preflight cannot identify reliably; keep the checkout outside OneDrive, Google Drive, Dropbox, and similar synced folders.

Node 24.0 and 24.1 are unsupported: their bundled libuv can return inconsistent Windows file identity metadata, causing safe configuration reads to fail. [Node 24.2.0](https://nodejs.org/en/blog/release/v24.2.0) includes libuv 1.51.0 with the [upstream fix](https://github.com/libuv/libuv/commit/82cdfb75f). Use a current patch release of a supported Node line.

```bash
git clone https://github.com/tournierjc/kinetick-code.git
cd kinetick-code
corepack enable
corepack prepare pnpm@9.12.0 --activate
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm kcode --help
pnpm kcode
```

If your Node.js installation does not include Corepack, install the exact pnpm version using your existing package manager. Native dependencies without matching prebuilt binaries require C/C++ build tools and Python: the C++ workload in Visual Studio Build Tools on Windows, Command Line Tools on macOS, or the system build toolchain on Linux.

The build extracts mcode-tools from a pinned public `@minimax-ai/code` archive and verifies both archive and CLI hashes. The cache is in `.cache/artifacts`. On integrity failure, check the network or remove that cache and retry; never bypass hash verification.

To use the CLI in another project, open that project's directory and run the built entry point by absolute path:

```bash
node /absolute/path/to/kinetick-code/dist/cli.js
```

On Windows, also use `node` with the appropriate local absolute path. Do not overwrite another globally installed command with this source build.

## Accounts and data

Prefer **`/provider`** (or `kcode provider` / `pnpm kcode provider`) for OpenRouter, DeepSeek, GitHub Copilot,
local endpoints, custom APIs, and other connections. MiniMax OAuth / Token Plan remains available via
`kcode login` (optional `--region cn|global` when needed) or `/login` in the TUI. Token Plan requires an
account and available credits. See the root README for BYOK configuration and testing.

Builds from this repository and installs of this repository's release archives use the same default user
data directory:

| CLI artifact | Default user data directory |
| --- | --- |
| GitHub release archive (`kinetick-code`) | `~/.minimax` |
| Build from this repository | `~/.minimax` |

A selected profile uses `~/.minimax-<profile>`. The default is defined in
[`data-dir.ts`](../packages/tui/src/runtime/data-dir.ts). Login state, provider configuration such as
`config.yaml`, caches, and sessions belong to the selected data directory.

Both accept a non-empty `MINIMAX_DATA_DIR`, falling back to a non-empty `MAVIS_DATA_DIR`, before the default.
The npm install location for the `kinetick-code` package is separate from this data directory.

Earlier source builds used `~/.minimax-code` for user data. The current default does not move or merge that
data. To keep using an existing source-build data directory, explicitly set `MINIMAX_DATA_DIR` to its path.

To locate data safely:

1. Identify the launcher you actually use with `command -v kcode` (POSIX) or `Get-Command kcode -All` (PowerShell), and run that launcher's `--version`. For a local npm dependency, use `node_modules/.bin/kcode --version`; a global npm listing does not identify it.
2. Check whether either data-directory override is set in that launcher's environment. Otherwise use `~/.minimax` (or `~/.minimax-<profile>`). Inspect directory and file names/permissions locally, without printing `config.yaml`, authentication files, or session contents. For builds from this repository, `kcode telemetry status` also reports the selected `configFile` path without printing credentials.
3. If more than one candidate directory exists, their presence alone does not identify the active one. Keep them protected, and include the launcher, version, installation method, and whether overrides are set when requesting help. Redact personal path components; do not attach configuration or authentication files. Changing an override does not migrate existing data, so do not move or delete directories merely to match these docs.

For tests, explicitly set `MINIMAX_DATA_DIR` to a temporary directory to keep normal sessions separate. Use `$env:MINIMAX_DATA_DIR = 'C:\path\to\test-profile'` in PowerShell or `export MINIMAX_DATA_DIR=/path/to/test-profile` in a POSIX shell.


## macOS terminal shortcuts: Ghostty Option+M

In the composer, `Alt+M` (`Option+M` on macOS) cycles permission modes through Ask, Auto, and Full access. Its binding ID is `composer.cycle-permission`. `Shift+Tab` toggles **Plan mode**, a separate setting. You can also use `/permission` to choose a permission mode and `/permission status` to inspect it without an Option shortcut.

If `Option+M` inserts `µ` instead, the terminal is sending text rather than the expected Alt shortcut. KCode preserves literal `µ` as text; it cannot safely infer a permission change from that character. The terminal must forward the modifier, or you can choose another binding.

### Configure Ghostty's Option key

Ghostty's [`macos-option-as-alt`](https://ghostty.org/docs/config/reference#macos-option-as-alt) default is **keyboard-layout dependent** when unset, not always `false`. The current reference lists U.S. Standard and U.S. International as defaulting to `true`; other layouts default to `false`. Check the active macOS input source and the configuration loaded by your installed Ghostty version.

Set this in your Ghostty configuration to send both Option keys as Alt:

```ini
macos-option-as-alt = true
```

Use `left` or `right` instead of `true` to reserve only that Option key for shortcuts and retain Unicode composition on the other side. Use the configured side when testing `Option+M`.

Follow Ghostty's [configuration locations and precedence](https://ghostty.org/docs/config#file-location): macOS-specific files load after XDG files, and later settings can override earlier ones. Inspect the loaded setting from the same Ghostty installation, without `--default`:

```bash
ghostty +show-config | awk '/^macos-option-as-alt[[:space:]]*=/'
```

If `ghostty` is not on `PATH`, use the executable inside your installed app bundle, typically `/Applications/Ghostty.app/Contents/MacOS/ghostty`. An empty or omitted value is not proof of `false`; unset behavior depends on the layout. After editing, reload Ghostty's configuration from its menu (default `Cmd+Shift+,`) and open a new terminal. This is separate from KCode's `/reload` command.

### Keep Option for text and customize KCode instead

While idle, open `/hotkeys`, select `composer.cycle-permission`, press `Enter`, press `Ctrl+X`, then press `Enter` to save. `Ctrl+X` is unused by the current default KCode bindings; check any custom terminal or multiplexer bindings too. Do not choose `Ctrl+M`: terminals commonly encode it identically to `Enter`.

Alternatively, merge this entry into `<data-dir>/tui/keybindings.json`, preserving any existing entries:

```json
{
  "composer.cycle-permission": "ctrl+x"
}
```

For the default profile this is `~/.minimax/tui/keybindings.json`; [profiles and data-directory overrides](#accounts-and-data) change the path. Create the `tui` directory if needed. After editing the file, run `/reload` while idle with no pending interaction or queued message, or restart KCode. This replaces `Alt+M`; use `["alt+m", "ctrl+x"]` as the value to retain both bindings. `/hotkeys` shows the effective binding.

### Verify the result

With an idle composer and no open picker or permission prompt, note `/permission status`, press the configured shortcut, and check the status again. The mode should advance without inserting text. Restore your intended permission mode through `/permission` afterward. Confirm that `Shift+Tab` still toggles Plan mode and that pasting `µ` still inserts text.

If it still fails, record `kcode --version`, Ghostty's version, active keyboard layout, which Option key you pressed, the setting above, the effective `/hotkeys` entry, and whether tmux or SSH is involved. Compare with a direct Ghostty session. KCode supports both legacy ESC-prefixed Alt input and extended keyboard reports; a shell's raw-key display alone does not establish what Ghostty sends after the TUI negotiates its keyboard protocol.

## Update or remove

A source checkout is not updated by the built-in updater, which prints the release install command
instead (see [Updating](#updating)). Save your changes, fetch a reviewed revision with Git, then repeat
the frozen install and build. A source installation does not automatically become an official npm installation.

To uninstall a source build, save any work and remove the source directory you created. Separately stored user data remains in place. See [Uninstall](../README.md#uninstall) for npm / source removal, optional leftover-upstream cleanup, and optional user-data deletion.

## Historical rename note

Earlier public names for this fork included the repository `tournierjc/minimax-code-fork`, the command
`mcode`, and archives named `minimax-code-<version>.tar.gz`. GitHub redirects the old repository URLs.
Current installs use **`kcode`** and `kinetick-code-<version>.tar.gz`. An older `mcode` launcher keeps
working until a current archive is installed. User data paths were not renamed with the product.

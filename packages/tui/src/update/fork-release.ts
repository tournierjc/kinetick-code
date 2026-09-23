/**
 * Fork release channel.
 *
 * The fork publishes one installer archive per release as a GitHub Release
 * asset on its own repository, next to a `.sha256` file (docs/releasing.md).
 * This module is the update source for that channel: it resolves the newest
 * release for a channel from the GitHub API, verifies the archive against the
 * checksum published beside it, and installs it with the package manager that
 * owns the running installation. No upstream endpoint is contacted.
 *
 * Trust model: the archive and its checksum come from the same release, over
 * TLS, from the repository pinned below. That is the trust a manual fork
 * install already relies on (`sha256sum -c` on the downloaded archive). It is
 * weaker than the upstream channel, whose manifest is signed with a key that
 * the upstream installer writes into `install.json`; the fork has no such key,
 * so these values are the whole contract:
 *
 *   - the release is selected by tag from the pinned repository,
 *   - the archive name must match the release version,
 *   - the downloaded bytes must match the published SHA-256 and the size the
 *     API reports for the asset.
 *
 * `KCODE_UPDATE_SOURCE=upstream` restores the previous npm registry and
 * managed-installer behaviour for callers that want it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  McodeUpdateCancelledError,
  reportMcodeUpdatePhase,
  throwIfMcodeUpdateCancelled,
  type McodeUpdateOperationOptions,
} from './progress.js';
import { compareMcodeVersions, parseMcodeVersion } from './release.js';
import type { McodeInstallSource, McodeNpmPrefixInstall } from './install-source.js';

export const KCODE_FORK_REPOSITORY = 'tournierjc/kinetick-code';
export const KCODE_FORK_RELEASES_URL = `https://github.com/${KCODE_FORK_REPOSITORY}/releases`;
export const KCODE_FORK_API_BASE_URL = 'https://api.github.com';
export const KCODE_FORK_RELEASE_PAGE_SIZE = 30;
/** Command this build installs, and therefore the launcher an update replaces. */
export const KCODE_COMMAND_NAME = 'kcode';
/** Runtime dependency registry used when installing the archive. */
export const KCODE_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const KCODE_UPDATE_SOURCE_ENV = 'KCODE_UPDATE_SOURCE';
export const KCODE_FORK_TOKEN_ENV = ['KCODE_FORK_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * Archive names accepted for a version. The fork published its first release as
 * `minimax-code-*` before the product rename, and an installation older than
 * that release must still be able to update itself.
 */
export const KCODE_FORK_ARCHIVE_NAMES = ['kinetick-code', 'minimax-code'] as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const VERSION_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const CHECKSUM_PATTERN = /^([0-9a-f]{64})(?:\s+\*?(.+))?$/u;

export type KcodeForkChannel = 'stable' | 'preview';

export interface KcodeForkArtifact {
  readonly name: string;
  /** API asset URL: what the updater fetches, with a token when one is available. */
  readonly url: string;
  /** Public download URL: what a person can install from by hand. */
  readonly downloadUrl: string;
  readonly size: number;
  readonly checksumUrl: string;
}

export interface KcodeForkRelease {
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly publishedAt: string;
  readonly artifact: KcodeForkArtifact;
}

export interface KcodeForkReleaseRequest extends McodeUpdateOperationOptions {
  channel?: string;
  version?: string;
  timeoutMs?: number;
}

export interface KcodeForkReleaseCheckResult {
  readonly status: 'available' | 'current' | 'ahead';
  readonly channel: KcodeForkChannel;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly release: KcodeForkRelease;
}

export interface KcodeForkReleaseApplyResult extends KcodeForkReleaseCheckResult {
  readonly applied: boolean;
  readonly restartRequired: boolean;
}

export interface KcodeForkReleaseDependencies {
  fetchBytes(
    url: string,
    options: {
      signal?: AbortSignal;
      environment: NodeJS.ProcessEnv;
      headers?: Record<string, string>;
    },
  ): Promise<Buffer>;
  runInstall(
    command: KcodeForkInstallCommand,
    environment: NodeJS.ProcessEnv,
    options: McodeUpdateOperationOptions,
  ): Promise<void>;
  readInstalledPackageVersion(): string | undefined;
}

export interface KcodeForkInstallCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly display: string;
}

export interface KcodeForkReleaseServiceOptions {
  readonly currentVersion: string;
  readonly installSource: McodeInstallSource;
  readonly prefixInstall?: McodeNpmPrefixInstall;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly entryFile?: string;
  readonly apiBaseUrl?: string;
  readonly dependencies?: Partial<KcodeForkReleaseDependencies>;
}

/**
 * The fork source owns every installation this build can have: a package
 * manager global install, or an npm prefix. A managed install root belongs to
 * the upstream installer, whose signed channel keys on its own product id, so
 * it keeps the previous behaviour.
 */
export function usesKcodeForkUpdateSource(
  installSource: McodeInstallSource,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment[KCODE_UPDATE_SOURCE_ENV]?.trim().toLowerCase() === 'upstream') return false;
  return installSource !== 'managed-installer';
}

export function parseKcodeForkChannel(value: string): KcodeForkChannel {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'stable' || normalized === 'preview') return normalized;
  throw new Error(`Unsupported KCode fork update channel: ${JSON.stringify(value)}`);
}

export function kcodeForkArchiveNames(version: string): readonly string[] {
  return KCODE_FORK_ARCHIVE_NAMES.map((prefix) => `${prefix}-${version}.tar.gz`);
}

/**
 * Select the release to update to. `stable` ignores prereleases, which is what
 * every `-fork.N` release is; `preview` accepts them, and is the default for a
 * fork installation.
 */
export function selectKcodeForkRelease(
  payload: unknown,
  options: { channel: KcodeForkChannel; version?: string },
): KcodeForkRelease {
  const entries = Array.isArray(payload) ? payload : [payload];
  const candidates: KcodeForkRelease[] = [];
  for (const entry of entries) {
    const release = readKcodeForkRelease(entry);
    if (!release) continue;
    if (options.version && release.version !== options.version) continue;
    if (!options.version && options.channel === 'stable' && release.prerelease) continue;
    candidates.push(release);
  }
  if (candidates.length === 0) {
    throw new Error(
      options.version
        ? `KCode release ${options.version} is not published on ${KCODE_FORK_RELEASES_URL}.`
        : `No KCode fork release is published for the ${options.channel} channel on ${KCODE_FORK_RELEASES_URL}.`,
    );
  }
  return candidates.reduce((best, candidate) =>
    compareMcodeVersions(candidate.version, best.version) > 0 ? candidate : best,
  );
}

function readKcodeForkRelease(value: unknown): KcodeForkRelease | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const release = value as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };
  if (release.draft === true) return undefined;
  if (typeof release.tag_name !== 'string') return undefined;
  const match = VERSION_TAG_PATTERN.exec(release.tag_name.trim());
  if (!match?.[1]) return undefined;
  let version: string;
  try {
    version = parseMcodeVersion(match[1]);
  } catch {
    return undefined;
  }
  const artifact = readKcodeForkArtifact(release.assets, version);
  if (!artifact) return undefined;
  return {
    tag: release.tag_name.trim(),
    version,
    prerelease: release.prerelease === true,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    artifact,
  };
}

function readKcodeForkArtifact(assets: unknown, version: string): KcodeForkArtifact | undefined {
  if (!Array.isArray(assets)) return undefined;
  const byName = new Map<string, { url: string; size: number; apiUrl: string }>();
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue;
    const entry = asset as {
      name?: unknown;
      size?: unknown;
      url?: unknown;
      browser_download_url?: unknown;
    };
    if (typeof entry.name !== 'string') continue;
    const url =
      typeof entry.browser_download_url === 'string' ? entry.browser_download_url : undefined;
    const apiUrl = typeof entry.url === 'string' ? entry.url : undefined;
    if (!url || !apiUrl) continue;
    byName.set(entry.name, {
      url,
      apiUrl,
      size: typeof entry.size === 'number' ? entry.size : Number.NaN,
    });
  }
  for (const name of kcodeForkArchiveNames(version)) {
    const archive = byName.get(name);
    if (!archive) continue;
    const checksumName = `${name}.sha256`;
    const checksum = byName.get(checksumName);
    if (!checksum) {
      throw new Error(
        `KCode release ${version} publishes ${name} without its ${checksumName} checksum; ` +
          'the archive cannot be verified.',
      );
    }
    return {
      name,
      url: archive.apiUrl,
      downloadUrl: archive.url,
      size: archive.size,
      checksumUrl: checksum.apiUrl,
    };
  }
  throw new Error(
    `KCode release ${version} does not publish ${kcodeForkArchiveNames(version).join(' or ')}.`,
  );
}

/** Read `<sha256>  <archive name>` as published beside the archive. */
export function parseKcodeForkChecksum(text: string, archiveName: string): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines.map((line) => CHECKSUM_PATTERN.exec(line)).filter((match) => match !== null);
  if (parsed.length === 0) {
    throw new Error(`KCode checksum file for ${archiveName} is not a SHA-256 digest list.`);
  }
  const entry =
    parsed.find((match) => match[2]?.replace(/^\.\//u, '') === archiveName) ?? parsed[0];
  if (!entry?.[1]) throw new Error(`KCode checksum file for ${archiveName} is incomplete.`);
  if (entry[2] && entry[2].replace(/^\.\//u, '') !== archiveName) {
    throw new Error(`KCode checksum file names ${entry[2]}, but ${archiveName} was downloaded.`);
  }
  return entry[1];
}

export function verifyKcodeForkArtifact(
  bytes: Buffer,
  artifact: KcodeForkArtifact,
  expectedSha256: string,
): void {
  if (Number.isFinite(artifact.size) && bytes.length !== artifact.size) {
    throw new Error(
      `KCode artifact size verification failed for ${artifact.name}: ` +
        `expected ${String(artifact.size)} bytes, got ${bytes.length}.`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(
      `KCode artifact checksum verification failed for ${artifact.name}: ` +
        `expected ${expectedSha256}, got ${digest}.`,
    );
  }
}

/**
 * Install command for a downloaded archive. The archive carries no registry
 * identity, so the package manager installs it from disk and resolves the
 * runtime dependencies (native SQLite, ripgrep) from the registry.
 */
export function buildKcodeForkInstallCommand(
  source: Exclude<McodeInstallSource, 'managed-installer' | 'unsupported'>,
  archivePath: string,
  options: { platform?: NodeJS.Platform; prefix?: string; registry?: string } = {},
): KcodeForkInstallCommand {
  const platform = options.platform ?? process.platform;
  const registry = options.registry ?? KCODE_NPM_REGISTRY;
  const npmArgs = [
    '--ignore-scripts=false',
    '--include=optional',
    '--allow-scripts=@minimax-ai/code,better-sqlite3',
    '--registry',
    registry,
  ];
  switch (source) {
    case 'npm-prefix': {
      if (!options.prefix) throw new Error('KCode npm prefix ownership metadata is missing.');
      return {
        executable: platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install', '--global', '--prefix', options.prefix, archivePath, ...npmArgs],
        display: `npm install --global --prefix ${options.prefix} ${archivePath}`,
      };
    }
    case 'npm-global':
      return {
        executable: platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install', '--global', archivePath, ...npmArgs],
        display: `npm install --global ${archivePath}`,
      };
    case 'pnpm-global':
      return {
        executable: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        args: ['add', '--global', archivePath, '--registry', registry],
        display: `pnpm add --global ${archivePath}`,
      };
    case 'yarn-global':
      return {
        executable: platform === 'win32' ? 'yarn.cmd' : 'yarn',
        args: ['global', 'add', archivePath, '--registry', registry],
        display: `yarn global add ${archivePath}`,
      };
    case 'bun-global':
      return {
        executable: platform === 'win32' ? 'bun.exe' : 'bun',
        args: ['add', '--global', archivePath, '--registry', registry],
        display: `bun add --global ${archivePath}`,
      };
  }
}

export class KcodeForkReleaseService {
  private readonly currentVersion: string;
  private readonly installSource: McodeInstallSource;
  private readonly prefixInstall?: McodeNpmPrefixInstall;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly apiBaseUrl: string;
  private readonly dependencies: KcodeForkReleaseDependencies;

  constructor(options: KcodeForkReleaseServiceOptions) {
    this.currentVersion = parseMcodeVersion(options.currentVersion);
    this.installSource = options.installSource;
    this.prefixInstall = options.prefixInstall;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.apiBaseUrl = (options.apiBaseUrl ?? KCODE_FORK_API_BASE_URL).replace(/\/+$/u, '');
    this.dependencies = {
      fetchBytes: (url, fetchOptions) =>
        fetchKcodeForkBytes(url, {
          ...fetchOptions,
          environment: this.environment,
          token: readKcodeForkToken(this.environment),
        }),
      runInstall: defaultRunKcodeForkInstall,
      readInstalledPackageVersion: () => undefined,
      ...options.dependencies,
    };
  }

  async check(request: KcodeForkReleaseRequest = {}): Promise<KcodeForkReleaseCheckResult> {
    throwIfMcodeUpdateCancelled(request.signal);
    reportMcodeUpdatePhase(request, 'checking', true);
    const channel = parseKcodeForkChannel(request.channel ?? this.resolveChannel());
    const version = request.version ? parseMcodeVersion(request.version) : undefined;
    const release = await this.resolveRelease({
      channel,
      ...(version ? { version } : {}),
      request,
    });
    const comparison = compareMcodeVersions(this.currentVersion, release.version);
    return {
      status: comparison < 0 ? 'available' : comparison > 0 ? 'ahead' : 'current',
      channel,
      currentVersion: this.currentVersion,
      latestVersion: release.version,
      release,
    };
  }

  /**
   * Install the release archive into the installation that owns this process.
   * The archive is verified before anything is written, and the install is
   * validated against the running package version afterwards.
   */
  async apply(request: KcodeForkReleaseRequest = {}): Promise<KcodeForkReleaseApplyResult> {
    const check = await this.check(request);
    if (check.status === 'current') return { ...check, applied: false, restartRequired: false };
    if (check.status === 'ahead' && !request.version) {
      throw new Error(
        `Installed KCode ${this.currentVersion} is newer than the fork ${check.channel} channel ` +
          `${check.latestVersion}; no update was applied.`,
      );
    }
    if (this.platform === 'win32') {
      throw new Error(
        'KCode fork releases are validated on Linux and macOS only. Install the archive from ' +
          `${KCODE_FORK_RELEASES_URL} manually.`,
      );
    }
    if (this.installSource === 'unsupported' || this.installSource === 'managed-installer') {
      throw new Error(
        `KCode cannot update this installation automatically. Install the archive from ` +
          `${KCODE_FORK_RELEASES_URL} manually.`,
      );
    }

    const timeoutMs = normalizeKcodeForkTimeout(request.timeoutMs);
    const controller = new AbortController();
    const detach = forwardKcodeForkAbort(request.signal, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`KCode update timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    const stagingDirectory = mkdtempSync(path.join(tmpdir(), 'kcode-update-'));
    try {
      reportMcodeUpdatePhase(request, 'downloading', true);
      const archivePath = path.join(stagingDirectory, check.release.artifact.name);
      const [archiveBytes, checksumBytes] = await Promise.all([
        this.dependencies.fetchBytes(check.release.artifact.url, {
          signal: controller.signal,
          environment: this.environment,
        }),
        this.dependencies.fetchBytes(check.release.artifact.checksumUrl, {
          signal: controller.signal,
          environment: this.environment,
        }),
      ]);
      const expectedSha256 = parseKcodeForkChecksum(
        checksumBytes.toString('utf8'),
        check.release.artifact.name,
      );
      verifyKcodeForkArtifact(archiveBytes, check.release.artifact, expectedSha256);
      throwIfMcodeUpdateCancelled(request.signal);
      writeFileSync(archivePath, archiveBytes, { mode: 0o600 });

      const command = buildKcodeForkInstallCommand(this.installSource, archivePath, {
        platform: this.platform,
        ...(this.prefixInstall ? { prefix: this.prefixInstall.prefix } : {}),
        ...(this.prefixInstall ? { registry: this.prefixInstall.registry } : {}),
      });
      reportMcodeUpdatePhase(request, 'installing', false);
      await this.dependencies.runInstall(command, this.environment, request);
      reportMcodeUpdatePhase(request, 'validating', false);
      const installedVersion = this.dependencies.readInstalledPackageVersion();
      if (installedVersion !== check.latestVersion) {
        throw new Error(
          `KCode update installed ${installedVersion || '<unknown>'}; ` +
            `expected ${check.latestVersion}.`,
        );
      }
      reportMcodeUpdatePhase(request, 'completed', false);
      return { ...check, applied: true, restartRequired: true };
    } catch (error) {
      if (error instanceof McodeUpdateCancelledError || request.signal?.aborted) {
        throw new McodeUpdateCancelledError();
      }
      if (timedOut) {
        throw new Error(`KCode update timed out after ${timeoutMs}ms.`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      detach();
      rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }

  /**
   * Command that installs the newest release by hand, for a source checkout
   * where no package manager owns the installation.
   */
  async resolveInstallCommand(request: KcodeForkReleaseRequest = {}): Promise<string> {
    const channel = parseKcodeForkChannel(request.channel ?? this.resolveChannel());
    const release = await this.resolveRelease({ channel, request });
    return `npm install --global ${release.artifact.downloadUrl}`;
  }

  private resolveChannel(): string {
    const configured = this.readConfiguredChannel();
    return configured ?? 'preview';
  }

  private readConfiguredChannel(): string | undefined {
    const file = path.join(resolveKcodeForkInstallRoot(this.environment), 'update.json');
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { channel?: unknown };
      return typeof parsed.channel === 'string' ? parsed.channel : undefined;
    } catch (error) {
      throw new Error(
        `KCode update channel config is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async resolveRelease(input: {
    channel: KcodeForkChannel;
    version?: string;
    request: KcodeForkReleaseRequest;
  }): Promise<KcodeForkRelease> {
    const timeoutMs = normalizeKcodeForkTimeout(input.request.timeoutMs);
    const controller = new AbortController();
    const detach = forwardKcodeForkAbort(input.request.signal, controller);
    const timeout = setTimeout(() => {
      controller.abort(new Error(`KCode update check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    const url = input.version
      ? `${this.apiBaseUrl}/repos/${KCODE_FORK_REPOSITORY}/releases/tags/v${encodeURIComponent(input.version)}`
      : `${this.apiBaseUrl}/repos/${KCODE_FORK_REPOSITORY}/releases?per_page=${String(KCODE_FORK_RELEASE_PAGE_SIZE)}`;
    try {
      const bytes = await this.dependencies.fetchBytes(url, {
        signal: controller.signal,
        environment: this.environment,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      let payload: unknown;
      try {
        payload = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        throw new Error(
          `KCode release list is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return selectKcodeForkRelease(payload, {
        channel: input.channel,
        ...(input.version ? { version: input.version } : {}),
      });
    } finally {
      clearTimeout(timeout);
      detach();
    }
  }
}

/** The fork keeps its install root beside the upstream one, with its own name. */
export function resolveKcodeForkInstallRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.MCODE_INSTALL_ROOT) return path.resolve(environment.MCODE_INSTALL_ROOT);
  const dataHome =
    environment.XDG_DATA_HOME ?? path.join(homeDirectory(environment), '.local', 'share');
  return path.join(dataHome, 'kinetick-code');
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME ?? environment.USERPROFILE ?? tmpdir();
}

function normalizeKcodeForkTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error('KCode update timeout must be an integer between 100 and 600000 milliseconds.');
  }
  return value;
}

function readKcodeForkToken(environment: NodeJS.ProcessEnv): string | undefined {
  for (const name of KCODE_FORK_TOKEN_ENV) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * GitHub serves release assets through a redirect to a signed storage URL, so
 * the fetch follows redirects; each hop is still a socket the egress guard
 * checks by hostname.
 */
async function fetchKcodeForkBytes(
  url: string,
  options: {
    signal?: AbortSignal;
    environment: NodeJS.ProcessEnv;
    headers?: Record<string, string>;
    token?: string;
  },
): Promise<Buffer> {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: options.environment.HTTP_PROXY ?? options.environment.http_proxy,
    httpsProxy: options.environment.HTTPS_PROXY ?? options.environment.https_proxy,
    noProxy: options.environment.NO_PROXY ?? options.environment.no_proxy,
  });
  try {
    const response = await fetch(url, {
      signal: options.signal,
      dispatcher,
      redirect: 'follow',
      headers: {
        'user-agent': 'kinetick-code',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`KCode release server returned HTTP ${response.status} for ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await dispatcher.close();
  }
}

function forwardKcodeForkAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function defaultRunKcodeForkInstall(
  command: KcodeForkInstallCommand,
  environment: NodeJS.ProcessEnv,
  options: McodeUpdateOperationOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command.executable, [...command.args], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk: Buffer) => notifyKcodeForkOutput(options, chunk));
    child.stderr?.on('data', (chunk: Buffer) => notifyKcodeForkOutput(options, chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command.executable} failed (${
            signal ? `signal ${signal}` : `exit ${String(code)}`
          }); the previous installation is unchanged.`,
        ),
      );
    });
  });
}

function notifyKcodeForkOutput(options: McodeUpdateOperationOptions, chunk: Buffer): void {
  try {
    options.onOutput?.(chunk.toString('utf8'));
  } catch {
    // Progress rendering must never change the install result.
  }
}

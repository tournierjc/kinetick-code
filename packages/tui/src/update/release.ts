import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { KCODE_INSTALLABLE_PACKAGE_NAMES } from '../package-identity.js';
import {
  KcodeUpdateCancelledError,
  reportKcodeUpdatePhase,
  throwIfKcodeUpdateCancelled,
  type KcodeUpdateOperationOptions,
} from './progress.js';
import type { KcodePackageManagerInstallSource } from './install-source.js';

/**
 * Kinetick Code's release channel.
 *
 * A build of this repository updates from one source: its own GitHub Releases.
 * Every release publishes `kinetick-code-<version>.tar.gz` next to a `.sha256`
 * file; this module resolves the newest release for the channel through the
 * GitHub API, verifies the archive against the published size and digest, and
 * installs it with the package manager that owns the running installation.
 *
 * Trust model: the archive and its checksum come from the same release, over
 * TLS, from the repository pinned here — the same assurance as verifying a
 * download by hand. Access control on that repository and its releases is the
 * authorship boundary, so the updater proves integrity and provenance, not
 * authorship. Nothing here contacts an upstream distribution: this is the
 * product's own channel, not a mirror of someone else's.
 */

export const KCODE_RELEASE_REPOSITORY = 'tournierjc/kinetick-code';
export const KCODE_RELEASES_URL = `https://github.com/${KCODE_RELEASE_REPOSITORY}/releases`;
export const KCODE_RELEASE_API_BASE_URL = 'https://api.github.com';
export const KCODE_RELEASE_PAGE_SIZE = 30;
/** Registry the release archive resolves its runtime dependencies from. */
export const KCODE_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const KCODE_RELEASE_TOKEN_ENV = ['KCODE_RELEASE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

/**
 * Archive names accepted for a version. The first release was published under
 * the pre-rename `minimax-code-*` name, and an installation older than that
 * release must still be able to update itself.
 */
export const KCODE_RELEASE_ARCHIVE_PREFIXES = ['kinetick-code', 'minimax-code'] as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const VERSION_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const CHECKSUM_PATTERN = /^([0-9a-f]{64})(?:\s+\*?(.+))?$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;

export type KcodeReleaseChannel = 'stable' | 'preview';

/** Package managers that own an installation this module can replace. */
export type KcodeReleaseInstallSource = Exclude<KcodePackageManagerInstallSource, 'npm-prefix'>;

export interface KcodeReleaseArtifact {
  readonly name: string;
  /**
   * Preferred download URL (`browser_download_url`). Public releases need no
   * Accept dance and match a hand install from the releases page.
   */
  readonly url: string;
  /** Public download URL: what a person can install from by hand (same as `url`). */
  readonly downloadUrl: string;
  /**
   * API asset URL (`/releases/assets/<id>`). Used only when the preferred URL
   * fails — then fetched with a forced `Accept: application/octet-stream`.
   */
  readonly apiUrl: string;
  readonly size: number;
  /** Preferred checksum URL (`browser_download_url` of the `.sha256` asset). */
  readonly checksumUrl: string;
  /** API checksum asset URL — fallback with forced octet-stream Accept. */
  readonly checksumApiUrl: string;
}

export interface KcodeRelease {
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly publishedAt: string;
  readonly artifact: KcodeReleaseArtifact;
}

export interface KcodeReleaseRequest extends KcodeUpdateOperationOptions {
  channel?: string;
  version?: string;
  timeoutMs?: number;
}

export interface KcodeReleaseCheckResult {
  readonly status: 'available' | 'current' | 'ahead';
  readonly channel: KcodeReleaseChannel;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly release: KcodeRelease;
}

export interface KcodeReleaseApplyResult extends KcodeReleaseCheckResult {
  readonly applied: boolean;
  readonly restartRequired: boolean;
}

export interface KcodeReleaseDependencies {
  fetchBytes(
    url: string,
    options: {
      signal?: AbortSignal;
      environment: NodeJS.ProcessEnv;
      headers?: Record<string, string>;
    },
  ): Promise<Buffer>;
  runInstall(
    command: KcodeInstallCommand,
    environment: NodeJS.ProcessEnv,
    options: KcodeUpdateOperationOptions,
  ): Promise<void>;
  readInstalledPackageVersion(): string | undefined;
}

export interface KcodeInstallCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly display: string;
}

export interface KcodeReleaseServiceOptions {
  readonly currentVersion: string;
  /** Package manager that owns the running installation. */
  readonly installSource: KcodeReleaseInstallSource;
  /** Data root that holds `update.json`, resolved by the caller. */
  readonly installRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Environment for the install step, bound to this build's Node runtime. */
  readonly installEnvironment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly apiBaseUrl?: string;
  readonly dependencies?: Partial<KcodeReleaseDependencies>;
}

/** Reject anything that is not a version this product could have released. */
export function parseKcodeVersion(value: string): string {
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid KCode version: ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseKcodeReleaseChannel(value: string): KcodeReleaseChannel {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'stable' || normalized === 'preview') return normalized;
  throw new Error(`Unsupported KCode update channel: ${JSON.stringify(value)}`);
}

export function kcodeReleaseArchiveNames(version: string): readonly string[] {
  return KCODE_RELEASE_ARCHIVE_PREFIXES.map((prefix) => `${prefix}-${version}.tar.gz`);
}

/**
 * Select the release to update to. `stable` ignores prereleases, which is what
 * every fork release is; `preview` accepts them and is the default here.
 */
export function selectKcodeRelease(
  payload: unknown,
  options: { channel: KcodeReleaseChannel; version?: string },
): KcodeRelease {
  const entries = Array.isArray(payload) ? payload : [payload];
  const candidates: KcodeRelease[] = [];
  for (const entry of entries) {
    const release = readKcodeRelease(entry);
    if (!release) continue;
    if (options.version && release.version !== options.version) continue;
    if (!options.version && options.channel === 'stable' && release.prerelease) continue;
    candidates.push(release);
  }
  if (candidates.length === 0) {
    throw new Error(
      options.version
        ? `KCode release ${options.version} is not published on ${KCODE_RELEASES_URL}.`
        : `No KCode release is published for the ${options.channel} channel on ${KCODE_RELEASES_URL}.`,
    );
  }
  return candidates.reduce((best, candidate) =>
    compareKcodeVersions(candidate.version, best.version) > 0 ? candidate : best,
  );
}

function readKcodeRelease(value: unknown): KcodeRelease | undefined {
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
    version = parseKcodeVersion(match[1]);
  } catch {
    return undefined;
  }
  const artifact = readKcodeArtifact(release.assets, version);
  if (!artifact) return undefined;
  return {
    tag: release.tag_name.trim(),
    version,
    prerelease: release.prerelease === true,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    artifact,
  };
}

function readKcodeArtifact(assets: unknown, version: string): KcodeReleaseArtifact | undefined {
  if (!Array.isArray(assets)) return undefined;
  const byName = new Map<string, { downloadUrl: string; apiUrl: string; size: number }>();
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue;
    const entry = asset as {
      name?: unknown;
      size?: unknown;
      url?: unknown;
      browser_download_url?: unknown;
    };
    if (typeof entry.name !== 'string') continue;
    const downloadUrl =
      typeof entry.browser_download_url === 'string' ? entry.browser_download_url : undefined;
    const apiUrl = typeof entry.url === 'string' ? entry.url : undefined;
    if (!downloadUrl || !apiUrl) continue;
    byName.set(entry.name, {
      downloadUrl,
      apiUrl,
      size: typeof entry.size === 'number' ? entry.size : Number.NaN,
    });
  }
  for (const name of kcodeReleaseArchiveNames(version)) {
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
      url: archive.downloadUrl,
      downloadUrl: archive.downloadUrl,
      apiUrl: archive.apiUrl,
      size: archive.size,
      checksumUrl: checksum.downloadUrl,
      checksumApiUrl: checksum.apiUrl,
    };
  }
  throw new Error(
    `KCode release ${version} does not publish ${kcodeReleaseArchiveNames(version).join(' or ')}.`,
  );
}

/**
 * True when `text` is GitHub release-asset metadata (or an API error envelope)
 * rather than a `.sha256` digest file. Fetching `/releases/assets/<id>` without
 * `Accept: application/octet-stream` yields this body.
 */
export function isKcodeGitHubAssetMetadataBody(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const body = parsed as Record<string, unknown>;
    if (typeof body.browser_download_url === 'string') return true;
    if (typeof body.url === 'string' && typeof body.node_id === 'string') return true;
    if (typeof body.message === 'string' && typeof body.documentation_url === 'string') return true;
    return false;
  } catch {
    return false;
  }
}

/** Read `<sha256>  <archive name>` as published beside the archive. */
export function parseKcodeChecksum(text: string, archiveName: string): string {
  if (isKcodeGitHubAssetMetadataBody(text)) {
    throw new Error(
      `KCode checksum fetch for ${archiveName} returned GitHub asset metadata JSON instead of ` +
        'the .sha256 digest file. Use the public browser_download_url, or fetch the asset API ' +
        'URL with Accept: application/octet-stream.',
    );
  }
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

export function verifyKcodeArtifact(
  bytes: Buffer,
  artifact: KcodeReleaseArtifact,
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
export function buildKcodeInstallCommand(
  source: KcodeReleaseInstallSource,
  archivePath: string,
  options: { platform?: NodeJS.Platform; registry?: string } = {},
): KcodeInstallCommand {
  const platform = options.platform ?? process.platform;
  const registry = options.registry ?? KCODE_NPM_REGISTRY;
  const npmArgs = [
    '--ignore-scripts=false',
    '--include=optional',
    `--allow-scripts=${KCODE_INSTALLABLE_PACKAGE_NAMES.join(',')},better-sqlite3`,
    '--registry',
    registry,
  ];
  switch (source) {
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

export class KcodeReleaseService {
  private readonly currentVersion: string;
  private readonly installSource: KcodeReleaseInstallSource;
  private readonly installRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly installEnvironment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly apiBaseUrl: string;
  private readonly dependencies: KcodeReleaseDependencies;

  constructor(options: KcodeReleaseServiceOptions) {
    this.currentVersion = parseKcodeVersion(options.currentVersion);
    this.installSource = options.installSource;
    this.installRoot = options.installRoot;
    this.environment = options.environment ?? process.env;
    this.installEnvironment = options.installEnvironment ?? this.environment;
    this.platform = options.platform ?? process.platform;
    this.apiBaseUrl = (options.apiBaseUrl ?? KCODE_RELEASE_API_BASE_URL).replace(/\/+$/u, '');
    this.dependencies = {
      fetchBytes: (url, fetchOptions) =>
        fetchKcodeBytes(url, {
          ...fetchOptions,
          environment: this.environment,
          token: readKcodeToken(this.environment),
        }),
      runInstall: defaultRunKcodeInstall,
      readInstalledPackageVersion: () => undefined,
      ...options.dependencies,
    };
  }

  async check(request: KcodeReleaseRequest = {}): Promise<KcodeReleaseCheckResult> {
    throwIfKcodeUpdateCancelled(request.signal);
    reportKcodeUpdatePhase(request, 'checking', true);
    const channel = parseKcodeReleaseChannel(request.channel ?? this.resolveChannel());
    const version = request.version ? parseKcodeVersion(request.version) : undefined;
    const release = await this.resolveRelease({
      channel,
      ...(version ? { version } : {}),
      request,
    });
    const comparison = compareKcodeVersions(this.currentVersion, release.version);
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
  async apply(request: KcodeReleaseRequest = {}): Promise<KcodeReleaseApplyResult> {
    const check = await this.check(request);
    if (check.status === 'current') return { ...check, applied: false, restartRequired: false };
    if (check.status === 'ahead' && !request.version) {
      throw new Error(
        `Installed KCode ${this.currentVersion} is newer than the ${check.channel} channel ` +
          `${check.latestVersion}; no update was applied.`,
      );
    }
    if (this.platform === 'win32') {
      throw new Error(
        'KCode releases are validated on Linux and macOS only. Install the archive from ' +
          `${KCODE_RELEASES_URL} manually.`,
      );
    }

    const timeoutMs = normalizeKcodeTimeout(request.timeoutMs);
    const controller = new AbortController();
    const detach = forwardKcodeAbort(request.signal, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`KCode update timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    const stagingDirectory = mkdtempSync(path.join(tmpdir(), 'kcode-update-'));
    try {
      reportKcodeUpdatePhase(request, 'downloading', true);
      const archivePath = path.join(stagingDirectory, check.release.artifact.name);
      const fetchOptions = {
        signal: controller.signal,
        environment: this.environment,
      };
      const [archiveBytes, checksumBytes] = await Promise.all([
        fetchKcodeReleaseAssetBytes(
          this.dependencies.fetchBytes,
          check.release.artifact.url,
          check.release.artifact.apiUrl,
          fetchOptions,
        ),
        fetchKcodeReleaseAssetBytes(
          this.dependencies.fetchBytes,
          check.release.artifact.checksumUrl,
          check.release.artifact.checksumApiUrl,
          fetchOptions,
        ),
      ]);
      const expectedSha256 = parseKcodeChecksum(
        checksumBytes.toString('utf8'),
        check.release.artifact.name,
      );
      verifyKcodeArtifact(archiveBytes, check.release.artifact, expectedSha256);
      throwIfKcodeUpdateCancelled(request.signal);
      writeFileSync(archivePath, archiveBytes, { mode: 0o600 });

      const command = buildKcodeInstallCommand(this.installSource, archivePath, {
        platform: this.platform,
      });
      reportKcodeUpdatePhase(request, 'installing', false);
      await this.dependencies.runInstall(command, this.installEnvironment, request);
      reportKcodeUpdatePhase(request, 'validating', false);
      const installedVersion = this.dependencies.readInstalledPackageVersion();
      if (installedVersion !== check.latestVersion) {
        throw new Error(
          `KCode update installed ${installedVersion || '<unknown>'}; ` +
            `expected ${check.latestVersion}.`,
        );
      }
      reportKcodeUpdatePhase(request, 'completed', false);
      return { ...check, applied: true, restartRequired: true };
    } catch (error) {
      if (error instanceof KcodeUpdateCancelledError || request.signal?.aborted) {
        throw new KcodeUpdateCancelledError();
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
  async resolveInstallCommand(request: KcodeReleaseRequest = {}): Promise<string> {
    const channel = parseKcodeReleaseChannel(request.channel ?? this.resolveChannel());
    const release = await this.resolveRelease({ channel, request });
    return `npm install --global ${release.artifact.downloadUrl}`;
  }

  /**
   * Channel the installation follows. This build publishes every release as a
   * prerelease, so `preview` is the default; `update.json` in the data root can
   * select `stable`, and an installation that already carries a channel keeps it.
   */
  private resolveChannel(): KcodeReleaseChannel {
    const file = path.join(this.installRoot, 'update.json');
    if (!existsSync(file)) return 'preview';
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `KCode update channel config is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const channel =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { channel?: unknown }).channel
        : undefined;
    return parseKcodeReleaseChannel(typeof channel === 'string' ? channel : 'preview');
  }

  private async resolveRelease(input: {
    channel: KcodeReleaseChannel;
    version?: string;
    request: KcodeReleaseRequest;
  }): Promise<KcodeRelease> {
    const timeoutMs = normalizeKcodeTimeout(input.request.timeoutMs);
    const controller = new AbortController();
    const detach = forwardKcodeAbort(input.request.signal, controller);
    const timeout = setTimeout(() => {
      controller.abort(new Error(`KCode update check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    const url = input.version
      ? `${this.apiBaseUrl}/repos/${KCODE_RELEASE_REPOSITORY}/releases/tags/v${encodeURIComponent(input.version)}`
      : `${this.apiBaseUrl}/repos/${KCODE_RELEASE_REPOSITORY}/releases?per_page=${String(KCODE_RELEASE_PAGE_SIZE)}`;
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
      return selectKcodeRelease(payload, {
        channel: input.channel,
        ...(input.version ? { version: input.version } : {}),
      });
    } finally {
      clearTimeout(timeout);
      detach();
    }
  }
}

interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string>;
}

function parsedVersion(value: string): ParsedVersion {
  parseKcodeVersion(value);
  const [coreText = '', prereleaseText] = value.split('-', 2);
  return {
    core: coreText.split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: prereleaseText
      ? prereleaseText.split('.').map((part) => (/^\d+$/u.test(part) ? Number(part) : part))
      : [],
  };
}

/** SemVer precedence, extended so `0.5.2-fork.2` follows `0.5.2-fork.1`. */
export function compareKcodeVersions(left: string, right: string): number {
  const leftVersion = parsedVersion(left);
  const rightVersion = parsedVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (rightVersion.prerelease.length === 0 && leftVersion.prerelease.length > 0) return -1;
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return leftPart - rightPart;
    if (typeof leftPart === 'number') return -1;
    if (typeof rightPart === 'number') return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function normalizeKcodeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error('KCode update timeout must be an integer between 100 and 600000 milliseconds.');
  }
  return value;
}

function readKcodeToken(environment: NodeJS.ProcessEnv): string | undefined {
  for (const name of KCODE_RELEASE_TOKEN_ENV) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * GitHub release asset API URLs (`/releases/assets/<id>`) return JSON metadata
 * unless the client asks for the raw bytes. With a token present that mistake
 * looks like a successful download of the wrong body — the checksum parser then
 * rejects "not a SHA-256 digest list". Browser download URLs are unaffected.
 */
export function isKcodeGitHubReleaseAssetApiUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return /\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/u.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Merge caller headers with the Accept value GitHub requires for asset bytes.
 * For asset API URLs, `Accept: application/octet-stream` always wins — a stale
 * `application/vnd.github+json` from a release-list caller must not stick.
 */
export function kcodeReleaseFetchHeaders(
  url: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  const merged = { ...headers };
  if (isKcodeGitHubReleaseAssetApiUrl(url)) {
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === 'accept') delete merged[key];
    }
    merged.accept = 'application/octet-stream';
  }
  return merged;
}

/**
 * Prefer the public `browser_download_url`; fall back to the API asset URL
 * (with forced octet-stream Accept inside `fetchKcodeBytes`) when needed —
 * private assets, transient browser-URL failures, etc.
 */
export async function fetchKcodeReleaseAssetBytes(
  fetchBytes: KcodeReleaseDependencies['fetchBytes'],
  preferredUrl: string,
  apiUrl: string,
  options: {
    signal?: AbortSignal;
    environment: NodeJS.ProcessEnv;
    headers?: Record<string, string>;
  },
): Promise<Buffer> {
  try {
    return await fetchBytes(preferredUrl, options);
  } catch (primaryError) {
    if (preferredUrl === apiUrl || options.signal?.aborted) throw primaryError;
    try {
      return await fetchBytes(apiUrl, options);
    } catch (fallbackError) {
      throw new Error(
        `KCode asset download failed for ${preferredUrl}${
          fallbackError instanceof Error ? ` (API fallback: ${fallbackError.message})` : ''
        }`,
        { cause: primaryError },
      );
    }
  }
}

/**
 * GitHub serves release assets through a redirect to a signed storage URL, so
 * the fetch follows redirects; each hop is still a socket the egress guard
 * checks by hostname.
 */
async function fetchKcodeBytes(
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
        ...kcodeReleaseFetchHeaders(url, options.headers),
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

function forwardKcodeAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function defaultRunKcodeInstall(
  command: KcodeInstallCommand,
  environment: NodeJS.ProcessEnv,
  options: KcodeUpdateOperationOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command.executable, [...command.args], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (chunk: Buffer) => notifyKcodeOutput(options, chunk));
    child.stderr?.on('data', (chunk: Buffer) => notifyKcodeOutput(options, chunk));
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

function notifyKcodeOutput(options: KcodeUpdateOperationOptions, chunk: Buffer): void {
  try {
    options.onOutput?.(chunk.toString('utf8'));
  } catch {
    // Progress rendering must never change the install result.
  }
}
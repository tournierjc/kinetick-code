import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { homedir } from 'node:os';
import {
  KCODE_PACKAGE_DIR_PATTERN,
  KCODE_WORKSPACE_PACKAGE_NAME,
  isInternalKcodePackageName,
  isKcodePackageName,
  type KcodePackageName,
} from '../package-identity.js';
import { KCODE_NPM_REGISTRY } from './release.js';

export { isInternalKcodePackageName };

/** Identity this product is installed under, current or historical. */
export type KcodeNpmPackageName = KcodePackageName;
export type KcodePackageManagerInstallSource =
  | 'npm-global'
  | 'npm-prefix'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global';

export type KcodeInstallSource =
  | 'managed-installer'
  | KcodePackageManagerInstallSource
  | 'unsupported';

export interface KcodeNpmPrefixInstall {
  readonly executable: string;
  readonly packageName: KcodeNpmPackageName;
  readonly prefix: string;
  readonly registry: string;
}

export interface DetectKcodeInstallSourceDependencies {
  readonly installRoot: string;
  readonly platform: NodeJS.Platform;
  readonly packageRoot: () => string | undefined;
  readonly npmGlobalPrefix: () => Promise<string>;
  readonly managedInstall: (installRoot: string) => boolean;
  readonly prefixInstall: () => KcodeNpmPrefixInstall | undefined;
}

export async function detectKcodeInstallSource(
  dependencies: Partial<DetectKcodeInstallSourceDependencies> & { installRoot: string },
): Promise<KcodeInstallSource> {
  const platform = dependencies.platform ?? process.platform;
  const resolved: DetectKcodeInstallSourceDependencies = {
    installRoot: dependencies.installRoot,
    platform,
    packageRoot: dependencies.packageRoot ?? resolveKcodePackageRoot,
    npmGlobalPrefix:
      dependencies.npmGlobalPrefix ??
      (() => runText(platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '--global'])),
    managedInstall: dependencies.managedInstall ?? isManagedKcodeInstallRoot,
    prefixInstall: dependencies.prefixInstall ?? resolveKcodeNpmPrefixInstall,
  };

  if (resolved.managedInstall(resolved.installRoot)) return 'managed-installer';
  if (resolved.prefixInstall()) return 'npm-prefix';

  const packageRoot = resolved.packageRoot();
  if (!packageRoot) return 'unsupported';
  const heuristic = classifyKcodeInstallPath(packageRoot);
  if (heuristic) return heuristic;

  try {
    return classifyNpmGlobalInstall(packageRoot, await resolved.npmGlobalPrefix(), platform);
  } catch {
    return 'unsupported';
  }
}

/**
 * Data root for this build: it holds `update.json` (release channel) and, for
 * an installation made by the upstream installer, that installer's
 * `install.json` receipt. The paths are kept as they are so an installation
 * created before the rename keeps finding its own data.
 */
export function resolveKcodeInstallRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.MCODE_INSTALL_ROOT) return path.resolve(environment.MCODE_INSTALL_ROOT);
  if (process.platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData)
      throw new Error('LOCALAPPDATA is required to resolve the KCode install root.');
    return path.join(localAppData, 'MinimaxCode');
  }
  const dataHome = environment.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(dataHome, 'minimax-code');
}

/**
 * Whether the upstream installer owns this installation, judged by the receipt
 * it writes into the data root. Such an installation carries that product's
 * identity throughout its layout, so this build does not update it in place.
 */
export function isManagedKcodeInstallRoot(installRoot: string): boolean {
  const metadataFile = path.join(installRoot, 'install.json');
  try {
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, unknown>;
    return metadata.product === 'minimax-code' && metadata.updateOwner === 'mcode-installer';
  } catch {
    return false;
  }
}

export function classifyKcodeInstallPath(
  packageRoot: string,
): KcodePackageManagerInstallSource | undefined {
  const normalized = packageRoot.replaceAll('\\', '/').toLocaleLowerCase();
  if (
    new RegExp(`/pnpm/global/(?:v11/[^/]+|[^/]+)/node_modules/${KCODE_PACKAGE_DIR_PATTERN}$`, 'u').test(normalized)
  ) {
    return 'pnpm-global';
  }
  if (
    new RegExp(`/(?:\\.config/yarn|\\.yarn)/global/node_modules/${KCODE_PACKAGE_DIR_PATTERN}$`, 'u').test(normalized)
  ) {
    return 'yarn-global';
  }
  if (new RegExp(`/\\.bun/install/global/node_modules/${KCODE_PACKAGE_DIR_PATTERN}$`, 'u').test(normalized)) {
    return 'bun-global';
  }
  if (
    new RegExp(`/lib/node_modules/${KCODE_PACKAGE_DIR_PATTERN}$`, 'u').test(normalized) ||
    new RegExp(`/npm/node_modules/${KCODE_PACKAGE_DIR_PATTERN}$`, 'u').test(normalized)
  ) {
    return 'npm-global';
  }
  return undefined;
}

export function classifyNpmGlobalInstall(
  packageRoot: string,
  globalPrefix: string,
  platform: NodeJS.Platform = process.platform,
): KcodeInstallSource {
  const normalizedRoot = normalizeResolvedPath(packageRoot, platform);
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const packageName =
    kcodePackageNameFromPath(packageRoot) ?? KCODE_WORKSPACE_PACKAGE_NAME;
  const candidates =
    platform === 'win32'
      ? [platformPath.join(globalPrefix, 'node_modules', packageName)]
      : [
          platformPath.join(globalPrefix, 'lib', 'node_modules', packageName),
          platformPath.join(globalPrefix, 'node_modules', packageName),
        ];
  return candidates.some(
    (candidate) => normalizeResolvedPath(candidate, platform) === normalizedRoot,
  )
    ? 'npm-global'
    : 'unsupported';
}

export function createKcodeNpmRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeExecutable: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const result = { ...environment };
  // Windows environment keys are case-insensitive. Keep only one PATH key so Node and
  // cross-spawn cannot choose a different inherited spelling.
  const pathKeys = Object.keys(result)
    .filter((key) => (platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'))
    .sort();
  const inheritedPath = result[pathKeys[0] ?? 'PATH'];
  for (const key of pathKeys) delete result[key];
  result.PATH = [platformPath.dirname(runtimeExecutable), inheritedPath]
    .filter(Boolean)
    .join(platformPath.delimiter);
  return result;
}

export function resolveKcodePackageName(
  entryFile = process.argv[1],
): KcodeNpmPackageName | undefined {
  return resolveKcodePackageIdentity(entryFile)?.packageName;
}

export function resolveInstalledKcodePackageVersion(
  entryFile = process.argv[1],
): string | undefined {
  return resolveKcodePackageIdentity(entryFile)?.version;
}

export function resolveKcodeNpmPrefixInstall(
  entryFile = process.argv[1],
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
): KcodeNpmPrefixInstall | undefined {
  const identity = resolveKcodePackageIdentity(entryFile);
  if (!identity) return undefined;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  // The package sits either directly in `node_modules` or behind a scope directory,
  // so the containing `node_modules` is found rather than assumed at a fixed depth.
  const packageParent = platformPath.dirname(identity.packageRoot);
  const nodeModules = [packageParent, platformPath.dirname(packageParent)].find(
    (candidate) => platformPath.basename(candidate).toLocaleLowerCase() === 'node_modules',
  );
  if (!nodeModules) return undefined;
  const nodeModulesParent = platformPath.dirname(nodeModules);
  const packagePrefix =
    platform !== 'win32' && platformPath.basename(nodeModulesParent) === 'lib'
      ? platformPath.dirname(nodeModulesParent)
      : nodeModulesParent;
  const receipt = findNpmPrefixReceipt(packagePrefix, identity.packageRoot, platform, platformPath);
  if (receipt) {
    if (receipt.packageName !== identity.packageName) return undefined;
    return receipt;
  }

  if (platformPath.basename(packagePrefix).toLocaleLowerCase() !== '.minimax-code')
    return undefined;
  const adjacentNpm = platformPath.join(
    platformPath.dirname(nodeExecutable),
    platform === 'win32' ? 'npm.cmd' : 'npm',
  );
  if (!existsSync(adjacentNpm)) return undefined;
  // No receipt beside the package: this is the installer's layout, described
  // here only so the installation is classified rather than claimed.
  return {
    executable: adjacentNpm,
    packageName: identity.packageName,
    prefix: packagePrefix,
    registry: KCODE_NPM_REGISTRY,
  };
}

function resolveKcodePackageRoot(entryFile = process.argv[1]): string | undefined {
  return resolveKcodePackageIdentity(entryFile)?.packageRoot;
}

function resolveKcodePackageIdentity(
  entryFile: string | undefined,
): { packageName: KcodeNpmPackageName; packageRoot: string; version?: string } | undefined {
  if (!entryFile) return undefined;
  let current: string;
  try {
    const resolved = realpathSync(entryFile);
    current = statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return undefined;
  }

  for (;;) {
    const manifestFile = path.join(current, 'package.json');
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        const packageName = parseKcodePackageName(manifest.name);
        if (packageName) {
          return {
            packageName,
            packageRoot: current,
            ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
          };
        }
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findNpmPrefixReceipt(
  packagePrefix: string,
  packageRoot: string,
  platform: NodeJS.Platform,
  platformPath: typeof path.posix | typeof path.win32,
): KcodeNpmPrefixInstall | undefined {
  let candidate = packagePrefix;
  for (let depth = 0; depth < 3; depth += 1) {
    const receipt = readNpmPrefixReceipt(
      candidate,
      packagePrefix,
      packageRoot,
      platform,
      platformPath,
    );
    if (receipt) return receipt;
    const parent = platformPath.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return undefined;
}

function readNpmPrefixReceipt(
  prefix: string,
  packagePrefix: string,
  packageRoot: string,
  platform: NodeJS.Platform,
  platformPath: typeof path.posix | typeof path.win32,
): KcodeNpmPrefixInstall | undefined {
  try {
    const raw = readFileSync(platformPath.join(prefix, 'install.json'), 'utf8').replace(
      /^\uFEFF/u,
      '',
    );
    const value = JSON.parse(raw) as {
      schemaVersion?: unknown;
      product?: unknown;
      updateOwner?: unknown;
      packageManager?: unknown;
      packageName?: unknown;
      registry?: unknown;
      distTag?: unknown;
      prefix?: unknown;
      npmExecutable?: unknown;
      layoutVersion?: unknown;
      releasesDirectory?: unknown;
      currentFile?: unknown;
    };
    const packageName = parseKcodePackageName(value.packageName);
    const legacyLayout = value.schemaVersion === 1 && value.layoutVersion === undefined;
    const versionedLayout =
      value.schemaVersion === 2 &&
      value.layoutVersion === 2 &&
      value.releasesDirectory === 'releases' &&
      value.currentFile === 'current';
    if (
      (!legacyLayout && !versionedLayout) ||
      value.product !== 'minimax-code' ||
      value.updateOwner !== 'npm-prefix' ||
      value.packageManager !== 'npm' ||
      !packageName ||
      typeof value.registry !== 'string' ||
      value.distTag !== 'latest' ||
      typeof value.prefix !== 'string' ||
      typeof value.npmExecutable !== 'string'
    ) {
      return undefined;
    }
    const registry = new URL(value.registry).href;
    if (
      normalizeResolvedPath(value.prefix, platform) !== normalizeResolvedPath(prefix, platform) ||
      !existsSync(value.npmExecutable)
    ) {
      return undefined;
    }
    if (
      legacyLayout &&
      normalizeResolvedPath(packagePrefix, platform) !== normalizeResolvedPath(prefix, platform)
    ) {
      return undefined;
    }
    if (versionedLayout) {
      const expectedReleasesRoot = platformPath.join(prefix, 'releases');
      const relativeRelease = platformPath.relative(expectedReleasesRoot, packagePrefix);
      if (
        !relativeRelease ||
        relativeRelease.startsWith('..') ||
        platformPath.isAbsolute(relativeRelease) ||
        relativeRelease.includes(platformPath.sep) ||
        !/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(relativeRelease) ||
        !isResolvedPathInside(packagePrefix, packageRoot, platformPath)
      ) {
        return undefined;
      }
    }
    return {
      executable: value.npmExecutable,
      packageName,
      prefix,
      registry,
    };
  } catch {
    return undefined;
  }
}

function isResolvedPathInside(
  root: string,
  candidate: string,
  platformPath: typeof path.posix | typeof path.win32,
): boolean {
  const relative = platformPath.relative(
    platformPath.resolve(root),
    platformPath.resolve(candidate),
  );
  return relative !== '' && !relative.startsWith('..') && !platformPath.isAbsolute(relative);
}

function parseKcodePackageName(value: unknown): KcodeNpmPackageName | undefined {
  return isKcodePackageName(value) ? value : undefined;
}

/**
 * Identity of the package directory a build is running from: the product's own
 * name directly under `node_modules`, or a scoped historical name, which needs
 * its scope segment to be read back.
 */
function kcodePackageNameFromPath(packageRoot: string): KcodeNpmPackageName | undefined {
  const normalized = packageRoot.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const last = segments.at(-1);
  const scoped = parseKcodePackageName(`${segments.at(-2)}/${last}`);
  return parseKcodePackageName(last) ?? scoped;
}

function normalizeResolvedPath(value: string, platform: NodeJS.Platform): string {
  let resolved: string;
  try {
    resolved = realpathSync(value);
  } catch {
    resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(value);
  }
  return platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function runText(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8').trim());
        return;
      }
      const details = Buffer.concat([...stderr, ...stdout])
        .toString('utf8')
        .trim();
      reject(
        new Error(
          `${command} failed (${
            signal ? `signal ${signal}` : `exit ${String(code)}`
          })${details ? `: ${details}` : ''}`,
        ),
      );
    });
  });
}

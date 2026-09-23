import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  McodeUpdateApplication,
  mcodeUpdateChannelLabel,
  type McodeUpdateApplicationDependencies,
  type McodeUpdateApplicationOptions,
  type McodeUpdatePlan,
  type ReleaseUpdateService,
} from '../../src/update/application.js';
import {
  classifyMcodeInstallPath,
  classifyNpmGlobalInstall,
  detectMcodeInstallSource,
  isInternalMcodePackageName,
  isManagedMcodeInstallRoot,
  resolveInstalledMcodePackageVersion,
  resolveMcodeInstallRoot,
  resolveMcodeNpmPrefixInstall,
  resolveMcodePackageName,
} from '../../src/update/install-source.js';
import {
  inspectPendingMcodePrefixUpdate,
  resolveMcodePrefixLauncherPairs,
  resolveMcodePrefixModulesRoot,
  writeMcodePrefixUpdatePending,
  type McodePrefixUpdateActivation,
} from '../../src/update/prefix-update.js';
import {
  KCODE_RELEASES_URL,
  type KcodeReleaseApplyResult,
  type KcodeReleaseCheckResult,
} from '../../src/update/release.js';

const RELEASE_ARTIFACT_URL =
  'https://github.com/tournierjc/kinetick-code/releases/download/v1.2.4/' +
  'kinetick-code-1.2.4.tar.gz';
const PENDING_UPDATE_FILE = '.mcode-update-pending.json';

describe('KCode install source classification', () => {
  it.each([
    ['/opt/homebrew/lib/node_modules/@minimax-ai/code', 'npm-global'],
    ['C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@minimax\\code', 'npm-global'],
    ['/usr/local/lib/node_modules/@minimax-ai/code', 'npm-global'],
    ['/Users/demo/.local/share/pnpm/global/5/node_modules/@minimax-ai/code', 'pnpm-global'],
    [
      '/Users/demo/Library/pnpm/global/v11/10c0afe5/node_modules/@minimax-ai/code',
      'pnpm-global',
    ],
    [
      'C:\\Users\\demo\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@minimax\\code',
      'pnpm-global',
    ],
    [
      'C:\\Users\\demo\\AppData\\Local\\pnpm\\global\\v11\\10c0afe5\\node_modules\\@minimax-ai\\code',
      'pnpm-global',
    ],
    ['/Users/demo/.config/yarn/global/node_modules/@minimax-ai/code', 'yarn-global'],
    [
      'C:\\Users\\demo\\.config\\yarn\\global\\node_modules\\@minimax\\code',
      'yarn-global',
    ],
    ['/Users/demo/.bun/install/global/node_modules/@minimax-ai/code', 'bun-global'],
    [
      'C:\\Users\\demo\\.bun\\install\\global\\node_modules\\@minimax\\code',
      'bun-global',
    ],
  ] as const)('classifies %s as %s', (packageRoot, expected) => {
    expect(classifyMcodeInstallPath(packageRoot)).toBe(expected);
  });

  it.each([
    ['/usr/local/lib/node_modules/@minimax-ai/code', '/usr/local', 'linux'],
    [
      'C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@minimax\\code',
      'C:\\Users\\demo\\AppData\\Roaming\\npm',
      'win32',
    ],
  ] as const)('recognizes npm global ownership for %s', (packageRoot, prefix, platform) => {
    expect(classifyNpmGlobalInstall(packageRoot, prefix, platform)).toBe('npm-global');
  });

  it('denies npm global ownership for a directory outside the reported prefix', () => {
    expect(
      classifyNpmGlobalInstall('/srv/apps/tools/lib/node_modules/@minimax-ai/code', '/usr/local'),
    ).toBe('unsupported');
  });
});

describe('KCode install source detection ordering', () => {
  const publicPackageRoot = '/usr/local/lib/node_modules/@minimax-ai/code';
  const prefixInstall = {
    executable: '/opt/minimax/runtime/node/bin/npm',
    packageName: '@minimax-ai/code' as const,
    prefix: '/opt/minimax',
    registry: 'https://registry.npmjs.org/',
  };

  it('prefers the managed installer receipt over every other owner', async () => {
    const packageRoot = vi.fn(() => publicPackageRoot);
    const detectPrefixInstall = vi.fn(() => prefixInstall);

    await expect(
      detectMcodeInstallSource({
        installRoot: '/managed',
        platform: 'linux',
        packageRoot,
        npmGlobalPrefix: async () => '/usr/local',
        managedInstall: () => true,
        prefixInstall: detectPrefixInstall,
      }),
    ).resolves.toBe('managed-installer');
    expect(detectPrefixInstall).not.toHaveBeenCalled();
    expect(packageRoot).not.toHaveBeenCalled();
  });

  it('prefers an npm-prefix receipt over the package-manager layouts', async () => {
    const packageRoot = vi.fn(() => publicPackageRoot);

    await expect(
      detectMcodeInstallSource({
        installRoot: '/opt/minimax',
        platform: 'linux',
        packageRoot,
        npmGlobalPrefix: async () => '/usr/local',
        managedInstall: () => false,
        prefixInstall: () => prefixInstall,
      }),
    ).resolves.toBe('npm-prefix');
    expect(packageRoot).not.toHaveBeenCalled();
  });

  it('classifies a global package-manager layout without querying the npm prefix', async () => {
    const npmGlobalPrefix = vi.fn(async () => '/usr/local');

    await expect(
      detectMcodeInstallSource({
        installRoot: '/source',
        platform: 'linux',
        packageRoot: () => publicPackageRoot,
        npmGlobalPrefix,
        managedInstall: () => false,
        prefixInstall: () => undefined,
      }),
    ).resolves.toBe('npm-global');
    expect(npmGlobalPrefix).not.toHaveBeenCalled();
  });

  it('falls back to the npm global prefix when no layout marker matches', async () => {
    const npmGlobalPrefix = vi.fn(async () => '/srv/apps/tools');

    await expect(
      detectMcodeInstallSource({
        installRoot: '/source',
        platform: 'linux',
        packageRoot: () => '/srv/apps/tools/node_modules/@minimax-ai/code',
        npmGlobalPrefix,
        managedInstall: () => false,
        prefixInstall: () => undefined,
      }),
    ).resolves.toBe('npm-global');
    expect(npmGlobalPrefix).toHaveBeenCalledOnce();
  });

  it('reports an unsupported installation when the npm prefix cannot be resolved', async () => {
    await expect(
      detectMcodeInstallSource({
        installRoot: '/source',
        platform: 'linux',
        packageRoot: () => '/srv/apps/tools/node_modules/@minimax-ai/code',
        npmGlobalPrefix: async () => {
          throw new Error('npm is not installed');
        },
        managedInstall: () => false,
        prefixInstall: () => undefined,
      }),
    ).resolves.toBe('unsupported');
  });

  it('reports an unsupported installation when the entry file has no package root', async () => {
    await expect(
      detectMcodeInstallSource({
        installRoot: '/source',
        platform: 'linux',
        packageRoot: () => undefined,
        npmGlobalPrefix: async () => '/usr/local',
        managedInstall: () => false,
        prefixInstall: () => undefined,
      }),
    ).resolves.toBe('unsupported');
  });

  it.each([
    '/Users/demo/project/pnpm/global/5/source/@minimax-ai/code',
    '/Users/demo/project/.config/yarn/global/source/@minimax-ai/code',
    '/Users/demo/project/.yarn/global/source/@minimax-ai/code',
    '/Users/demo/project/.bun/install/global/source/@minimax-ai/code',
  ] as const)(
    'reports a local checkout carrying the global-install marker as unsupported: %s',
    async (packageRoot) => {
      await expect(
        detectMcodeInstallSource({
          installRoot: '/source',
          platform: 'darwin',
          packageRoot: () => packageRoot,
          npmGlobalPrefix: async () => '/usr/local',
          managedInstall: () => false,
          prefixInstall: () => undefined,
        }),
      ).resolves.toBe('unsupported');
    },
  );
});

describe('KCode npm prefix ownership receipts', () => {
  it.each(['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])(
    'reads the installer prefix receipt and keeps its registry: %s',
    (registry) => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-prefix-receipt-')));
      const packageRoot = path.join(
        root,
        ...(process.platform === 'win32' ? [] : ['lib']),
        'node_modules',
        '@minimax-ai',
        'code',
      );
      const npmExecutable = path.join(
        root,
        'runtime',
        'node',
        ...(process.platform === 'win32' ? ['npm.cmd'] : ['bin', 'npm']),
      );
      const entryFile = path.join(packageRoot, 'cli.js');
      try {
        mkdirSync(packageRoot, { recursive: true });
        mkdirSync(path.dirname(npmExecutable), { recursive: true });
        writeFileSync(npmExecutable, '');
        writeFileSync(entryFile, '');
        writeFileSync(
          path.join(packageRoot, 'package.json'),
          JSON.stringify({ name: '@minimax-ai/code', version: '1.2.3' }),
        );
        writeFileSync(
          path.join(root, 'install.json'),
          `\uFEFF${JSON.stringify({
            schemaVersion: 1,
            product: 'minimax-code',
            updateOwner: 'npm-prefix',
            packageManager: 'npm',
            packageName: '@minimax-ai/code',
            registry,
            distTag: 'latest',
            prefix: root,
            npmExecutable,
          })}`,
        );

        expect(resolveMcodeNpmPrefixInstall(entryFile, process.platform)).toEqual({
          executable: npmExecutable,
          packageName: '@minimax-ai/code',
          prefix: realpathSync(root),
          registry,
        });
        expect(resolveInstalledMcodePackageVersion(entryFile)).toBe('1.2.3');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('resolves versioned installer ownership from a release package entry', () => {
    const prefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-prefix-versioned-')));
    const packageRoot = path.join(
      prefix,
      'releases/1.2.3',
      ...(process.platform === 'win32' ? [] : ['lib']),
      'node_modules/@minimax-ai/code',
    );
    const npmExecutable = path.join(
      prefix,
      process.platform === 'win32' ? 'runtime/node/npm.cmd' : 'runtime/node/bin/npm',
    );
    const entryFile = path.join(packageRoot, 'dist/index.js');
    try {
      mkdirSync(path.dirname(entryFile), { recursive: true });
      mkdirSync(path.dirname(npmExecutable), { recursive: true });
      writeFileSync(entryFile, '');
      writeFileSync(npmExecutable, '');
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code', version: '1.2.3' }),
      );
      writeFileSync(
        path.join(prefix, 'install.json'),
        JSON.stringify({
          schemaVersion: 2,
          product: 'minimax-code',
          updateOwner: 'npm-prefix',
          packageManager: 'npm',
          packageName: '@minimax-ai/code',
          registry: 'https://registry.npmjs.org/',
          distTag: 'latest',
          prefix,
          npmExecutable,
          layoutVersion: 2,
          releasesDirectory: 'releases',
          currentFile: 'current',
        }),
      );

      expect(resolveMcodeNpmPrefixInstall(entryFile, process.platform)).toEqual({
        executable: npmExecutable,
        packageName: '@minimax-ai/code',
        prefix: realpathSync(prefix),
        registry: 'https://registry.npmjs.org/',
      });
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it('recovers a legacy installer prefix only from its package root and adjacent npm', () => {
    const temporaryParent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-prefix-legacy-')));
    const prefix = path.join(temporaryParent, '.minimax-code');
    const packageRoot = path.join(resolveMcodePrefixModulesRoot(prefix), '@minimax-ai', 'code');
    const nodeExecutable = path.join(
      prefix,
      'runtime',
      'node',
      ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']),
    );
    const npmExecutable = path.join(
      prefix,
      'runtime',
      'node',
      ...(process.platform === 'win32' ? ['npm.cmd'] : ['bin', 'npm']),
    );
    const entryFile = path.join(packageRoot, 'cli.js');
    try {
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(path.dirname(nodeExecutable), { recursive: true });
      writeFileSync(nodeExecutable, '');
      writeFileSync(npmExecutable, '');
      writeFileSync(entryFile, '');
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code', version: '1.2.3' }),
      );

      expect(resolveMcodeNpmPrefixInstall(entryFile, process.platform, nodeExecutable)).toEqual({
        executable: npmExecutable,
        packageName: '@minimax-ai/code',
        prefix: realpathSync(prefix),
        registry: 'https://registry.npmjs.org/',
      });
    } finally {
      rmSync(temporaryParent, { recursive: true, force: true });
    }
  });

  it.each([
    ['an unknown product', { product: 'upstream-product' }],
    ['a foreign update owner', { updateOwner: 'mcode-installer' }],
    ['a package manager other than npm', { packageManager: 'pnpm' }],
    ['a package name outside the product scopes', { packageName: '@minimax-ai/other' }],
    ['a dist tag other than latest', { distTag: 'next' }],
    ['a schema version without its layout fields', { schemaVersion: 2 }],
    ['no registry', { registry: undefined }],
    ['no npm executable reference', { npmExecutable: undefined }],
  ] as const)('ignores an installer receipt carrying %s', (kind, patch) => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-receipt-invalid-')));
    const packageRoot = path.join(
      root,
      ...(process.platform === 'win32' ? [] : ['lib']),
      'node_modules',
      '@minimax-ai',
      'code',
    );
    const npmExecutable = path.join(
      root,
      'runtime',
      'node',
      ...(process.platform === 'win32' ? ['npm.cmd'] : ['bin', 'npm']),
    );
    const entryFile = path.join(packageRoot, 'cli.js');
    try {
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(path.dirname(npmExecutable), { recursive: true });
      writeFileSync(npmExecutable, '');
      writeFileSync(entryFile, '');
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code', version: '1.2.3' }),
      );
      writeFileSync(
        path.join(root, 'install.json'),
        JSON.stringify({
          schemaVersion: 1,
          product: 'minimax-code',
          updateOwner: 'npm-prefix',
          packageManager: 'npm',
          packageName: '@minimax-ai/code',
          registry: 'https://registry.npmjs.org/',
          distTag: 'latest',
          prefix: root,
          npmExecutable,
          ...patch,
        }),
      );

      expect(resolveMcodeNpmPrefixInstall(entryFile, process.platform)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores an installer receipt whose npm executable is gone', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-receipt-npm-gone-')));
    const packageRoot = path.join(
      root,
      ...(process.platform === 'win32' ? [] : ['lib']),
      'node_modules',
      '@minimax-ai',
      'code',
    );
    const entryFile = path.join(packageRoot, 'cli.js');
    try {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(entryFile, '');
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code', version: '1.2.3' }),
      );
      writeFileSync(
        path.join(root, 'install.json'),
        JSON.stringify({
          schemaVersion: 1,
          product: 'minimax-code',
          updateOwner: 'npm-prefix',
          packageManager: 'npm',
          packageName: '@minimax-ai/code',
          registry: 'https://registry.npmjs.org/',
          distTag: 'latest',
          prefix: root,
          npmExecutable: path.join(root, 'runtime', 'node', 'bin', 'npm-missing'),
        }),
      );

      expect(resolveMcodeNpmPrefixInstall(entryFile, process.platform)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores an installer receipt written for a different prefix', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-receipt-foreign-')));
    const otherPrefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-receipt-other-')));
    const packageRoot = path.join(
      root,
      ...(process.platform === 'win32' ? [] : ['lib']),
      'node_modules',
      '@minimax-ai',
      'code',
    );
    const npmExecutable = path.join(
      root,
      'runtime',
      'node',
      ...(process.platform === 'win32' ? ['npm.cmd'] : ['bin', 'npm']),
    );
    const entryFile = path.join(packageRoot, 'cli.js');
    try {
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(path.dirname(npmExecutable), { recursive: true });
      writeFileSync(npmExecutable, '');
      writeFileSync(entryFile, '');
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code', version: '1.2.3' }),
      );
      writeFileSync(
        path.join(root, 'install.json'),
        JSON.stringify({
          schemaVersion: 1,
          product: 'minimax-code',
          updateOwner: 'npm-prefix',
          packageManager: 'npm',
          packageName: '@minimax-ai/code',
          registry: 'https://registry.npmjs.org/',
          distTag: 'latest',
          prefix: otherPrefix,
          npmExecutable,
        }),
      );

      expect(resolveMcodeNpmPrefixInstall(entryFile, process.platform)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(otherPrefix, { recursive: true, force: true });
    }
  });

  it('reads the installed public package identity from its real entry path', () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'mcode-update-public-'));
    const packageRoot = path.join(
      temporaryRoot,
      'lib',
      'node_modules',
      '@minimax-ai',
      'code',
    );
    try {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code' }),
      );
      const entryFile = path.join(packageRoot, 'cli.js');
      writeFileSync(entryFile, '');

      expect(resolveMcodePackageName(entryFile)).toBe('@minimax-ai/code');
      expect(resolveInstalledMcodePackageVersion(entryFile)).toBeUndefined();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('recognizes only the internal package identity as environment-selectable', () => {
    expect(isInternalMcodePackageName('@minimax/code')).toBe(true);
    expect(isInternalMcodePackageName('@minimax-ai/code')).toBe(false);
    expect(isInternalMcodePackageName(undefined)).toBe(false);
  });
});

describe('KCode install root resolution', () => {
  it('prefers MCODE_INSTALL_ROOT and resolves it against the working directory', () => {
    expect(resolveMcodeInstallRoot({ MCODE_INSTALL_ROOT: '/opt/kcode/data' })).toBe(
      '/opt/kcode/data',
    );
    expect(resolveMcodeInstallRoot({ MCODE_INSTALL_ROOT: 'relative/data' })).toBe(
      path.resolve('relative/data'),
    );
  });

  it('defaults to the minimax-code directory under the XDG data home', () => {
    expect(resolveMcodeInstallRoot({ XDG_DATA_HOME: '/xdg/data' })).toBe(
      path.join('/xdg/data', 'minimax-code'),
    );
    expect(resolveMcodeInstallRoot({})).toBe(
      path.join(os.homedir(), '.local', 'share', 'minimax-code'),
    );
  });

  it.skipIf(process.platform === 'win32').each([
    [{ LOCALAPPDATA: String.raw`C:\Users\demo\AppData\Local` }, String.raw`C:\Users\demo\AppData\Local\MinimaxCode`],
    [undefined, undefined],
  ] as const)('uses the Windows LOCALAPPDATA data root', (environment, expected) => {
    // `resolveMcodeInstallRoot` reads `process.platform`, so the Windows branch is
    // entered by redefining the platform for the duration of this test.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      if (expected) {
        expect(resolveMcodeInstallRoot(environment)).toBe(
          path.join(String.raw`C:\Users\demo\AppData\Local`, 'MinimaxCode'),
        );
      } else {
        expect(() => resolveMcodeInstallRoot({})).toThrow(
          'LOCALAPPDATA is required to resolve the KCode install root.',
        );
      }
    } finally {
      if (descriptor) Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it.each([
    ['the current installer receipt', { product: 'minimax-code', updateOwner: 'mcode-installer' }, true],
    ['a receipt without a product', { updateOwner: 'mcode-installer' }, false],
    ['a receipt owned by another installer', { product: 'minimax-code' }, false],
    ['a receipt for another product', { product: 'other', updateOwner: 'mcode-installer' }, false],
  ] as const)('reports installer ownership from %s', (kind, receipt, expected) => {
    const installRoot = mkdtempSync(path.join(os.tmpdir(), 'mcode-managed-root-'));
    try {
      writeFileSync(path.join(installRoot, 'install.json'), JSON.stringify(receipt));

      expect(isManagedMcodeInstallRoot(installRoot)).toBe(expected);
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it('treats a missing or unreadable installer receipt as unowned', () => {
    const installRoot = mkdtempSync(path.join(os.tmpdir(), 'mcode-managed-missing-'));
    try {
      expect(isManagedMcodeInstallRoot(installRoot)).toBe(false);
      writeFileSync(path.join(installRoot, 'install.json'), '{');
      expect(isManagedMcodeInstallRoot(installRoot)).toBe(false);
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

describe('KCode prefix update journal', () => {
  function writePackage(modulesRoot: string, version: string): void {
    const packageRoot = path.join(modulesRoot, '@minimax-ai', 'code');
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@minimax-ai/code', version, bin: { mcode: 'dist/index.js' } }),
    );
  }

  function writeLaunchers(
    pairs: readonly { activePath: string; stagedPath: string }[],
    side: 'active' | 'staged',
  ): void {
    for (const pair of pairs) {
      const target = side === 'active' ? pair.activePath : pair.stagedPath;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, side === 'active' ? '1.2.4' : '1.2.4');
    }
  }

  function activation(
    prefix: string,
    stagingPrefix: string,
    expectedVersion: string,
  ): McodePrefixUpdateActivation {
    const activeModulesRoot = resolveMcodePrefixModulesRoot(prefix, process.platform);
    return {
      stagingPrefix,
      activePrefix: prefix,
      activeModulesRoot,
      stagedModulesRoot: resolveMcodePrefixModulesRoot(stagingPrefix, process.platform),
      backupModulesRoot: `${activeModulesRoot}.mcode-update-backup`,
      packageName: '@minimax-ai/code',
      expectedVersion,
      launchers: resolveMcodePrefixLauncherPairs(prefix, stagingPrefix, process.platform),
    };
  }

  function writeOwnershipReceipt(prefix: string): void {
    writeFileSync(
      path.join(prefix, 'install.json'),
      JSON.stringify({ updateOwner: 'npm-prefix', prefix }),
    );
  }

  it('reports a staged update whose staged package and launchers are complete', () => {
    const prefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-journal-staged-')));
    const stagingPrefix = path.join(path.dirname(prefix), `.${path.basename(prefix)}.staging`);
    const entryFile = path.join(
      resolveMcodePrefixModulesRoot(prefix),
      '@minimax-ai/code',
      'dist/index.js',
    );
    try {
      mkdirSync(path.dirname(entryFile), { recursive: true });
      writeFileSync(entryFile, '');
      writePackage(resolveMcodePrefixModulesRoot(prefix), '1.2.3');
      writePackage(resolveMcodePrefixModulesRoot(stagingPrefix), '1.2.4');
      writeOwnershipReceipt(prefix);
      const pending = activation(prefix, stagingPrefix, '1.2.4');
      writeLaunchers(pending.launchers, 'staged');
      const pendingFile = writeMcodePrefixUpdatePending(pending);

      expect(JSON.parse(readFileSync(pendingFile, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        activePrefix: prefix,
        expectedVersion: '1.2.4',
      });
      expect(inspectPendingMcodePrefixUpdate(entryFile)).toMatchObject({
        pendingFile,
        state: 'staged',
        activation: { expectedVersion: '1.2.4', stagingPrefix },
      });
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(stagingPrefix, { recursive: true, force: true });
    }
  });

  it('reports an activated update once the staged version is the active one', () => {
    const prefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-journal-active-')));
    const stagingPrefix = path.join(path.dirname(prefix), `.${path.basename(prefix)}.activated`);
    const entryFile = path.join(
      resolveMcodePrefixModulesRoot(prefix),
      '@minimax-ai/code',
      'dist/index.js',
    );
    try {
      mkdirSync(path.dirname(entryFile), { recursive: true });
      writeFileSync(entryFile, '');
      writePackage(resolveMcodePrefixModulesRoot(prefix), '1.2.4');
      writeOwnershipReceipt(prefix);
      const pending = activation(prefix, stagingPrefix, '1.2.4');
      writeLaunchers(pending.launchers, 'active');
      const pendingFile = writeMcodePrefixUpdatePending(pending);

      expect(inspectPendingMcodePrefixUpdate(entryFile)).toMatchObject({
        pendingFile,
        state: 'activated',
      });
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(stagingPrefix, { recursive: true, force: true });
    }
  });

  it('rejects a pending update whose staged package and launchers are missing', () => {
    const prefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-journal-missing-')));
    const stagingPrefix = path.join(path.dirname(prefix), `.${path.basename(prefix)}.missing`);
    const entryFile = path.join(
      resolveMcodePrefixModulesRoot(prefix),
      '@minimax-ai/code',
      'dist/index.js',
    );
    try {
      mkdirSync(path.dirname(entryFile), { recursive: true });
      writeFileSync(entryFile, '');
      writePackage(resolveMcodePrefixModulesRoot(prefix), '1.2.3');
      writeOwnershipReceipt(prefix);
      const pendingFile = writeMcodePrefixUpdatePending(activation(prefix, stagingPrefix, '1.2.4'));

      expect(() => inspectPendingMcodePrefixUpdate(entryFile)).toThrow(
        `KCode pending update artifacts are incomplete at ${pendingFile}.`,
      );
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(stagingPrefix, { recursive: true, force: true });
    }
  });

  it('reports malformed pending metadata instead of treating it as a staged update', () => {
    const prefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-journal-invalid-')));
    const entryFile = path.join(
      resolveMcodePrefixModulesRoot(prefix),
      '@minimax-ai/code',
      'dist/index.js',
    );
    const pendingFile = path.join(prefix, PENDING_UPDATE_FILE);
    try {
      mkdirSync(path.dirname(entryFile), { recursive: true });
      writeFileSync(entryFile, '');
      writePackage(resolveMcodePrefixModulesRoot(prefix), '1.2.3');
      writeOwnershipReceipt(prefix);
      writeFileSync(pendingFile, '{}');

      expect(() => inspectPendingMcodePrefixUpdate(entryFile)).toThrow(
        `KCode pending update metadata is invalid at ${pendingFile}.`,
      );
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it('rejects a pending journal owned by a different active prefix', () => {
    const prefix = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-journal-foreign-')));
    const foreignPrefix = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'mcode-journal-foreign-owner-')),
    );
    const foreignStaging = path.join(path.dirname(foreignPrefix), '.foreign-staging');
    const entryFile = path.join(
      resolveMcodePrefixModulesRoot(prefix),
      '@minimax-ai/code',
      'dist/index.js',
    );
    const pendingFile = path.join(prefix, PENDING_UPDATE_FILE);
    try {
      mkdirSync(path.dirname(entryFile), { recursive: true });
      writeFileSync(entryFile, '');
      writeOwnershipReceipt(prefix);
      writeFileSync(
        pendingFile,
        JSON.stringify({
          schemaVersion: 1,
          ...activation(foreignPrefix, foreignStaging, '1.2.4'),
        }),
      );

      expect(() => inspectPendingMcodePrefixUpdate(entryFile)).toThrow(
        `KCode pending update file is outside its active prefix: ${pendingFile}`,
      );
    } finally {
      rmSync(prefix, { recursive: true, force: true });
      rmSync(foreignPrefix, { recursive: true, force: true });
      rmSync(foreignStaging, { recursive: true, force: true });
    }
  });

  it('resolves the modules root and launcher pairs for each platform layout', () => {
    expect(resolveMcodePrefixModulesRoot('/opt/minimax', 'linux')).toBe(
      '/opt/minimax/lib/node_modules',
    );
    expect(resolveMcodePrefixLauncherPairs('/opt/minimax', '/opt/staging', 'linux')).toEqual([
      {
        activePath: '/opt/minimax/bin/mcode',
        stagedPath: '/opt/staging/bin/mcode',
        backupPath: '/opt/minimax/bin/mcode.mcode-update-backup',
      },
    ]);
    expect(
      resolveMcodePrefixModulesRoot(String.raw`C:\MinimaxCode`, 'win32'),
    ).toBe(String.raw`C:\MinimaxCode\node_modules`);
    expect(
      resolveMcodePrefixLauncherPairs(String.raw`C:\MinimaxCode`, String.raw`C:\Staging`, 'win32'),
    ).toEqual([
      {
        activePath: String.raw`C:\MinimaxCode\mcode.cmd`,
        stagedPath: String.raw`C:\Staging\mcode.cmd`,
        backupPath: String.raw`C:\MinimaxCode\mcode.cmd.mcode-update-backup`,
      },
      {
        activePath: String.raw`C:\MinimaxCode\mcode.ps1`,
        stagedPath: String.raw`C:\Staging\mcode.ps1`,
        backupPath: String.raw`C:\MinimaxCode\mcode.ps1.mcode-update-backup`,
      },
    ]);
  });
});

describe('McodeUpdateApplication', () => {
  it.each(['npm-global', 'pnpm-global', 'yarn-global', 'bun-global'] as const)(
    'plans a release update for a %s installation',
    async (installSource) => {
      const createReleaseService = vi.fn(() => createReleaseServiceStub());
      const application = createApplication({
        detectInstallSource: async () => installSource,
        createReleaseService,
      });

      await expect(application.inspect()).resolves.toEqual({
        kind: 'available',
        source: 'release',
        currentVersion: '1.2.3',
        latestVersion: '1.2.4',
        channel: 'preview',
        installSource,
        artifactUrl: RELEASE_ARTIFACT_URL,
      });
      expect(createReleaseService).toHaveBeenCalledWith(installSource);
      expect(createReleaseService).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['current', 'ahead'] as const)(
    'reports the release plan as %s when no newer release is published',
    async (status) => {
      const application = createApplication({
        detectInstallSource: async () => 'yarn-global',
        createReleaseService: () =>
          createReleaseServiceStub({
            check: async () => releaseCheckResult({ status, latestVersion: '1.2.2' }),
          }),
      });

      await expect(application.inspect()).resolves.toMatchObject({
        kind: status,
        source: 'release',
        channel: 'preview',
        installSource: 'yarn-global',
        latestVersion: '1.2.2',
      });
    },
  );

  it('points an unsupported installation at the release install command', async () => {
    const resolveInstallCommand = vi.fn(
      async () => `npm install --global ${RELEASE_ARTIFACT_URL}`,
    );
    const createReleaseService = vi.fn(() =>
      createReleaseServiceStub({ resolveInstallCommand }),
    );
    const application = createApplication({
      detectInstallSource: async () => 'unsupported',
      createReleaseService,
    });

    await expect(application.inspect()).resolves.toEqual({
      kind: 'manual',
      source: 'unsupported',
      currentVersion: '1.2.3',
      command: `npm install --global ${RELEASE_ARTIFACT_URL}`,
    });
    expect(createReleaseService).toHaveBeenCalledWith('npm-global');
    expect(resolveInstallCommand).toHaveBeenCalledWith();
  });

  it('falls back to the releases page when the install command cannot be resolved', async () => {
    const application = createApplication({
      detectInstallSource: async () => 'unsupported',
      createReleaseService: () =>
        createReleaseServiceStub({
          resolveInstallCommand: async () => {
            throw new Error('offline');
          },
        }),
    });

    const plan = await application.inspect();

    expect(plan).toMatchObject({ kind: 'manual', source: 'unsupported' });
    const command = (plan as { command: string }).command;
    expect(command).toContain(KCODE_RELEASES_URL);
    expect(command).toContain('npm install --global');
  });

  it.each([
    ['managed-installer', 'The upstream installer owns this installation'],
    ['npm-prefix', 'an npm prefix carrying the upstream installer layout'],
  ] as const)(
    'refuses to replace an upstream %s layout in place',
    async (installSource, layout) => {
      const createReleaseService = vi.fn(() => createReleaseServiceStub());
      const application = createApplication({
        detectInstallSource: async () => installSource,
        createReleaseService,
      });

      const error = await application.inspect().catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(layout);
      expect((error as Error).message).toContain(KCODE_RELEASES_URL);
      expect(createReleaseService).not.toHaveBeenCalled();
    },
  );

  it('reports an unsupported application for a local checkout carrying an install marker', async () => {
    const check = vi.fn(async () => releaseCheckResult());
    const application = createApplication({
      detectInstallSource: () =>
        detectMcodeInstallSource({
          installRoot: '/source',
          platform: 'darwin',
          packageRoot: () => '/Users/demo/project/.bun/install/global/source/@minimax-ai/code',
          npmGlobalPrefix: async () => '/usr/local',
          managedInstall: () => false,
          prefixInstall: () => undefined,
        }),
      createReleaseService: () => createReleaseServiceStub({ check }),
    });

    await expect(application.inspect()).resolves.toMatchObject({
      kind: 'manual',
      source: 'unsupported',
    });
    expect(check).not.toHaveBeenCalled();
  });

  it.each([true, false] as const)(
    'delegates an available update to the release service with restartRequired %s',
    async (restartRequired) => {
      const apply = vi.fn(async () => ({
        ...releaseCheckResult(),
        applied: true,
        restartRequired,
      }));
      const createReleaseService = vi.fn(() => createReleaseServiceStub({ apply }));
      const application = createApplication({
        detectInstallSource: async () => 'pnpm-global',
        createReleaseService,
      });

      const plan = await application.inspect();
      const signal = new AbortController().signal;
      const onOutput = vi.fn();
      const onPhase = vi.fn();

      await expect(application.apply(plan, { signal, onOutput, onPhase })).resolves.toEqual({
        applied: true,
        restartRequired,
        message:
          `KCode 1.2.4 is installed from ${KCODE_RELEASES_URL}. ` +
          'Restart running KCode sessions to use it.',
      });
      expect(createReleaseService).toHaveBeenLastCalledWith('pnpm-global');
      expect(apply).toHaveBeenCalledWith({
        channel: 'preview',
        version: '1.2.4',
        signal,
        onOutput,
        onPhase,
      });
    },
  );

  it('reports an already-active release when the service applies nothing', async () => {
    const apply = vi.fn(async () => ({
      ...releaseCheckResult(),
      applied: false,
      restartRequired: false,
      currentVersion: '1.2.4',
    }));
    const application = createApplication({
      detectInstallSource: async () => 'npm-global',
      createReleaseService: () => createReleaseServiceStub({ apply }),
    });

    const plan = await application.inspect();

    await expect(application.apply(plan)).resolves.toEqual({
      applied: false,
      message: 'KCode 1.2.4 is already active.',
    });
  });

  it.each(['manual', 'current', 'ahead'] as const)(
    'refuses to apply a %s plan automatically',
    async (kind) => {
      const createReleaseService = vi.fn(() => createReleaseServiceStub());
      const application = createApplication({ createReleaseService });
      const plan = (
        kind === 'manual'
          ? {
              kind,
              source: 'unsupported',
              currentVersion: '1.2.3',
              command: `npm install --global ${RELEASE_ARTIFACT_URL}`,
            }
          : {
              kind,
              source: 'release',
              currentVersion: '1.2.3',
              latestVersion: '1.2.4',
              channel: 'preview',
              installSource: 'npm-global',
              artifactUrl: RELEASE_ARTIFACT_URL,
            }
      ) as McodeUpdatePlan;

      await expect(application.apply(plan)).rejects.toThrow(
        `KCode update plan ${kind} cannot be applied automatically.`,
      );
      expect(createReleaseService).not.toHaveBeenCalled();
    },
  );

  it('labels a release plan with its channel and a manual plan with the release channel', async () => {
    const application = createApplication({
      detectInstallSource: async () => 'npm-global',
      createReleaseService: () =>
        createReleaseServiceStub({ check: async () => releaseCheckResult({ channel: 'stable' }) }),
    });
    const manualApplication = createApplication({
      detectInstallSource: async () => 'unsupported',
    });

    expect(mcodeUpdateChannelLabel(await application.inspect())).toBe('the stable channel');
    expect(mcodeUpdateChannelLabel(await manualApplication.inspect())).toBe('the release channel');
  });
});

function releaseCheckResult(
  overrides: Partial<KcodeReleaseCheckResult> = {},
): KcodeReleaseCheckResult {
  return {
    status: 'available',
    channel: 'preview',
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    release: {
      tag: 'v1.2.4',
      version: '1.2.4',
      prerelease: true,
      publishedAt: '2026-09-23T00:00:00Z',
      artifact: {
        name: 'kinetick-code-1.2.4.tar.gz',
        url: 'https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/1',
        downloadUrl: RELEASE_ARTIFACT_URL,
        size: 13_144_451,
        checksumUrl: 'https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/2',
      },
    },
    ...overrides,
  };
}

function createReleaseServiceStub(
  overrides: Partial<ReleaseUpdateService> = {},
): ReleaseUpdateService {
  return {
    check: async () => releaseCheckResult(),
    apply: async (): Promise<KcodeReleaseApplyResult> => ({
      ...releaseCheckResult(),
      applied: true,
      restartRequired: true,
    }),
    resolveInstallCommand: async () => `npm install --global ${RELEASE_ARTIFACT_URL}`,
    ...overrides,
  };
}

function createApplication(
  dependencies: Partial<McodeUpdateApplicationDependencies> = {},
  options: Partial<McodeUpdateApplicationOptions> = {},
): McodeUpdateApplication {
  // The release channel is the only update source this build owns, so every case
  // injects the service that resolves it instead of reaching the network.
  return new McodeUpdateApplication(
    {
      currentVersion: '1.2.3',
      installRoot: '/managed',
      environment: {},
      ...options,
    },
    {
      detectInstallSource: async () => 'npm-global',
      createReleaseService: () => createReleaseServiceStub(),
      readInstalledPackageVersion: () => undefined,
      ...dependencies,
    },
  );
}

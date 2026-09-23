import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KCODE_RELEASES_URL,
  KcodeReleaseService,
  buildKcodeInstallCommand,
  compareKcodeVersions,
  kcodeReleaseArchiveNames,
  parseKcodeChecksum,
  parseKcodeReleaseChannel,
  parseKcodeVersion,
  selectKcodeRelease,
  verifyKcodeArtifact,
  type KcodeRelease,
  type KcodeReleaseDependencies,
} from '../../src/update/release.js';
import { KcodeUpdateCancelledError } from '../../src/update/progress.js';

const ARCHIVE_BYTES = Buffer.from('kinetick code release archive bytes');
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Data root carrying an `update.json`, which is where the channel is read. */
function installRootWithChannel(channel?: unknown): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kcode-update-test-'));
  tempDirectories.push(directory);
  if (channel !== undefined) {
    writeFileSync(path.join(directory, 'update.json'), JSON.stringify({ channel }));
  }
  return directory;
}

function archiveName(version: string, prefix = 'kinetick-code'): string {
  return `${prefix}-${version}.tar.gz`;
}

function asset(name: string, size: number, tag = 'v0.0.0') {
  return {
    name,
    size,
    url: `https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/${name}`,
    browser_download_url:
      `https://github.com/tournierjc/kinetick-code/releases/download/${tag}/` + name,
  };
}

function releaseEntry(
  version: string,
  options: {
    prerelease?: boolean;
    draft?: boolean;
    prefix?: string;
    archiveBytes?: Buffer;
    omitChecksum?: boolean;
    checksumText?: string;
  } = {},
) {
  const name = archiveName(version, options.prefix);
  const tag = `v${version}`;
  const bytes = options.archiveBytes ?? ARCHIVE_BYTES;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const checksumText = options.checksumText ?? `${digest}  ${name}\n`;
  const assets = [asset(name, bytes.length, tag)];
  if (!options.omitChecksum) assets.push(asset(`${name}.sha256`, checksumText.length, tag));
  return {
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: '2026-09-22T09:43:59Z',
    assets,
    checksumText,
    archiveBytes: bytes,
  };
}

type ReleaseEntry = ReturnType<typeof releaseEntry>;

function assetUrlOf(entry: ReleaseEntry, name: string): string {
  const found = entry.assets.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`fixture is missing ${name}`);
  return found.url;
}

function browserUrlOf(entry: ReleaseEntry, name: string): string {
  const found = entry.assets.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`fixture is missing ${name}`);
  return found.browser_download_url;
}

function dependenciesFor(
  entries: ReleaseEntry[],
  overrides: Partial<KcodeReleaseDependencies> = {},
): KcodeReleaseDependencies {
  const archiveNameOf = (entry: ReleaseEntry): string => {
    const name = entry.assets[0]?.name;
    if (!name) throw new Error('fixture is missing its archive');
    return name;
  };
  return {
    fetchBytes: vi.fn(async (url: string) => {
      const tagMatch = /\/releases\/tags\/v(.+)$/u.exec(url);
      if (tagMatch?.[1]) {
        const entry = entries.find((candidate) => candidate.tag_name === `v${tagMatch[1]}`);
        if (!entry) return Buffer.from(JSON.stringify({ message: 'Not Found' }));
        return Buffer.from(JSON.stringify(entry));
      }
      if (url.includes('/releases?')) return Buffer.from(JSON.stringify(entries));
      for (const entry of entries) {
        const name = archiveNameOf(entry);
        if (url === assetUrlOf(entry, name)) return entry.archiveBytes;
        if (url === assetUrlOf(entry, `${name}.sha256`)) return Buffer.from(entry.checksumText);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
    runInstall: vi.fn(async () => undefined),
    readInstalledPackageVersion: vi.fn(() => undefined),
    ...overrides,
  };
}

function service(
  entries: ReleaseEntry[],
  dependencies: Partial<KcodeReleaseDependencies> = {},
  options: {
    currentVersion?: string;
    installSource?: 'npm-global' | 'pnpm-global' | 'yarn-global' | 'bun-global';
    installRoot?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): KcodeReleaseService {
  return new KcodeReleaseService({
    currentVersion: options.currentVersion ?? '0.5.2',
    installSource: options.installSource ?? 'npm-global',
    installRoot: options.installRoot ?? installRootWithChannel(),
    platform: options.platform ?? 'linux',
    environment: options.environment ?? {},
    dependencies: dependenciesFor(entries, dependencies),
  });
}

describe('KCode release channel', () => {
  it('selects the newest release for the preview channel, including prereleases', () => {
    const release = selectKcodeRelease(
      [
        releaseEntry('0.5.2-rc.1', { prerelease: true }),
        releaseEntry('0.5.3-rc.1', { prerelease: true }),
      ],
      { channel: 'preview' },
    );
    expect(release.version).toBe('0.5.3-rc.1');
    expect(release.prerelease).toBe(true);
    expect(release.artifact.name).toBe('kinetick-code-0.5.3-rc.1.tar.gz');
  });

  it('keeps the stable channel on published releases and ignores drafts', () => {
    const release = selectKcodeRelease(
      [
        releaseEntry('0.5.3-rc.1', { prerelease: true }),
        releaseEntry('0.5.4', { draft: true }),
        releaseEntry('0.5.2'),
      ],
      { channel: 'stable' },
    );
    expect(release.version).toBe('0.5.2');
    expect(release.prerelease).toBe(false);
  });

  it('accepts the pre-rename minimax-code archive name', () => {
    const release = selectKcodeRelease(
      [releaseEntry('0.5.2', { prefix: 'minimax-code' })],
      { channel: 'preview' },
    );
    expect(release.artifact.name).toBe('minimax-code-0.5.2.tar.gz');
    expect(kcodeReleaseArchiveNames('0.5.2')).toEqual([
      'kinetick-code-0.5.2.tar.gz',
      'minimax-code-0.5.2.tar.gz',
    ]);
  });

  it('rejects a release whose archive has no published checksum', () => {
    expect(() =>
      selectKcodeRelease([releaseEntry('0.5.3', { omitChecksum: true })], {
        channel: 'preview',
      }),
    ).toThrow(/without its .*\.sha256 checksum/u);
  });

  it('rejects a release that publishes no archive for the version', () => {
    const entry = releaseEntry('0.5.3-rc.1', { prerelease: true });
    entry.assets[0] = asset('something-else.tar.gz', 12);
    expect(() => selectKcodeRelease([entry], { channel: 'preview' })).toThrow(
      /does not publish kinetick-code-0\.5\.3-rc\.1\.tar\.gz/u,
    );
  });

  it('selects a pinned version and reports the releases page when it is absent', () => {
    const entries = [releaseEntry('0.5.2-rc.1', { prerelease: true })];
    expect(selectKcodeRelease(entries, { channel: 'preview', version: '0.5.2-rc.1' }).version).toBe(
      '0.5.2-rc.1',
    );
    expect(() => selectKcodeRelease(entries, { channel: 'preview', version: '9.9.9' })).toThrow(
      new RegExp(KCODE_RELEASES_URL, 'u'),
    );
  });

  it('reports the channel it accepts and refuses anything else', () => {
    expect(parseKcodeReleaseChannel('preview')).toBe('preview');
    expect(parseKcodeReleaseChannel(' STABLE ')).toBe('stable');
    expect(() => parseKcodeReleaseChannel('beta')).toThrow(/Unsupported KCode update channel/u);
  });

  it('parses the published checksum file and refuses a mismatched name', () => {
    const digest = 'a'.repeat(64);
    expect(
      parseKcodeChecksum(`${digest}  kinetick-code-0.5.3.tar.gz\n`, 'kinetick-code-0.5.3.tar.gz'),
    ).toBe(digest);
    expect(parseKcodeChecksum(`${'b'.repeat(64)}  ./name.tar.gz\n`, 'name.tar.gz')).toBe(
      'b'.repeat(64),
    );
    expect(() =>
      parseKcodeChecksum(`${digest}  other-name.tar.gz\n`, 'kinetick-code-0.5.3.tar.gz'),
    ).toThrow(/names other-name\.tar\.gz/u);
    expect(() => parseKcodeChecksum('not a digest list\n', 'kinetick-code-0.5.3.tar.gz')).toThrow(
      /not a SHA-256 digest list/u,
    );
  });

  it('verifies the archive against the published digest and size', () => {
    const name = archiveName('0.5.3');
    const release: KcodeRelease = {
      tag: 'v0.5.3',
      version: '0.5.3',
      prerelease: true,
      publishedAt: '2026-09-22T09:43:59Z',
      artifact: {
        name,
        url: 'https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/archive',
        downloadUrl: 'https://github.com/tournierjc/kinetick-code/releases/download/v0.5.3/' + name,
        size: ARCHIVE_BYTES.length,
        checksumUrl: 'https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/checksum',
      },
    };
    const digest = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
    expect(() => verifyKcodeArtifact(ARCHIVE_BYTES, release.artifact, digest)).not.toThrow();
    expect(() => verifyKcodeArtifact(ARCHIVE_BYTES, release.artifact, 'f'.repeat(64))).toThrow(
      /checksum verification failed/u,
    );
    expect(() =>
      verifyKcodeArtifact(
        Buffer.concat([ARCHIVE_BYTES, Buffer.from('extra')]),
        release.artifact,
        digest,
      ),
    ).toThrow(/size verification failed/u);
  });

  it('orders versions so a prerelease follows its release and its own builds', () => {
    expect(compareKcodeVersions('0.5.3', '0.5.2-rc.9')).toBeGreaterThan(0);
    expect(compareKcodeVersions('0.6.0-rc.2', '0.6.0-rc.1')).toBeGreaterThan(0);
    expect(compareKcodeVersions('0.6.0', '0.6.0-rc.1')).toBeGreaterThan(0);
    expect(compareKcodeVersions('0.6.0-rc.1', '0.6.0')).toBeLessThan(0);
    expect(compareKcodeVersions('0.6.0-rc.1', '0.6.0-rc.1')).toBe(0);
    expect(parseKcodeVersion('0.6.0-rc.1')).toBe('0.6.0-rc.1');
    expect(() => parseKcodeVersion('latest')).toThrow(/Invalid KCode version/u);
    expect(() => parseKcodeVersion('../0.5.2')).toThrow(/Invalid KCode version/u);
  });

  it('builds the install command for each owning package manager', () => {
    const archive = '/tmp/kcode-update/kinetick-code-0.5.3.tar.gz';
    expect(buildKcodeInstallCommand('npm-global', archive, { platform: 'linux' }).args).toEqual(
      expect.arrayContaining([
        'install',
        '--global',
        archive,
        '--ignore-scripts=false',
        '--allow-scripts=kinetick-code,@minimax-ai/code,better-sqlite3',
        '--registry',
        'https://registry.npmjs.org/',
      ]),
    );
    expect(buildKcodeInstallCommand('pnpm-global', archive).args).toEqual(
      expect.arrayContaining(['add', '--global', archive]),
    );
    expect(buildKcodeInstallCommand('yarn-global', archive).args).toEqual(
      expect.arrayContaining(['global', 'add', archive]),
    );
    expect(buildKcodeInstallCommand('bun-global', archive).args).toEqual(
      expect.arrayContaining(['add', '--global', archive]),
    );
    expect(buildKcodeInstallCommand('npm-global', archive, { platform: 'win32' }).executable).toBe(
      'npm.cmd',
    );
    expect(buildKcodeInstallCommand('pnpm-global', archive, { platform: 'win32' }).executable).toBe(
      'pnpm.cmd',
    );
  });
});

describe('KcodeReleaseService', () => {
  it('reports the newest release over the GitHub API', async () => {
    const serviceUnderTest = service([
      releaseEntry('0.5.2-rc.1', { prerelease: true }),
      releaseEntry('0.6.0-rc.1', { prerelease: true }),
    ]);
    const result = await serviceUnderTest.check({});
    expect(result.status).toBe('available');
    expect(result.channel).toBe('preview');
    expect(result.latestVersion).toBe('0.6.0-rc.1');
    expect(result.release.artifact.name).toBe('kinetick-code-0.6.0-rc.1.tar.gz');
  });

  it('reports current and ahead states against the channel', async () => {
    const entries = [releaseEntry('0.5.2-rc.1', { prerelease: true })];
    await expect(
      service(entries, {}, { currentVersion: '0.5.2-rc.1' }).check({}),
    ).resolves.toMatchObject({ status: 'current' });
    await expect(
      service(entries, {}, { currentVersion: '0.5.3' }).check({}),
    ).resolves.toMatchObject({ status: 'ahead' });
  });

  it('defaults to the preview channel and follows the one update.json selects', async () => {
    const entries = [releaseEntry('0.6.0', {}), releaseEntry('0.7.0-rc.1', { prerelease: true })];
    await expect(service(entries).check({})).resolves.toMatchObject({
      channel: 'preview',
      latestVersion: '0.7.0-rc.1',
    });
    await expect(
      service(entries, {}, { installRoot: installRootWithChannel('stable') }).check({}),
    ).resolves.toMatchObject({ channel: 'stable', latestVersion: '0.6.0' });
    await expect(
      service(entries, {}, { installRoot: installRootWithChannel('beta') }).check({}),
    ).rejects.toThrow(/Unsupported KCode update channel/u);
  });

  it('refuses a release list that is not JSON', async () => {
    const broken = service([], {
      fetchBytes: vi.fn(async () => Buffer.from('<html>not json</html>')),
    });
    await expect(broken.check({})).rejects.toThrow(/not valid JSON/u);
  });

  it('names the releases page when the channel has no release at all', async () => {
    await expect(service([]).check({})).rejects.toThrow(new RegExp(KCODE_RELEASES_URL, 'u'));
  });

  it('installs the verified archive and reports that a restart is required', async () => {
    const entry = releaseEntry('0.6.0-rc.1', { prerelease: true });
    const runInstall = vi.fn(async () => undefined);
    const serviceUnderTest = service([entry], {
      runInstall,
      readInstalledPackageVersion: () => '0.6.0-rc.1',
    });
    const result = await serviceUnderTest.apply({});
    expect(result.applied).toBe(true);
    expect(result.restartRequired).toBe(true);
    expect(runInstall).toHaveBeenCalledTimes(1);
    const [command, environment] = runInstall.mock.calls[0] as unknown as [
      { args: string[]; display: string },
      NodeJS.ProcessEnv,
    ];
    const archiveArgument = command.args.find((argument) => argument.endsWith('.tar.gz')) ?? '';
    expect(archiveArgument).toMatch(/kinetick-code-0\.6\.0-rc\.1\.tar\.gz$/u);
    expect(environment).toBeTypeOf('object');
    // The downloaded archive never outlives the update.
    expect(existsSync(archiveArgument)).toBe(false);
  });

  it('does not install anything when the installation is already current', async () => {
    const entry = releaseEntry('0.5.2-rc.1', { prerelease: true });
    const runInstall = vi.fn(async () => undefined);
    const result = await service(
      [entry],
      { runInstall },
      { currentVersion: '0.5.2-rc.1' },
    ).apply({});
    expect(result).toMatchObject({ status: 'current', applied: false, restartRequired: false });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('refuses to install an archive whose published checksum does not match', async () => {
    const entry = releaseEntry('0.6.0-rc.1', {
      prerelease: true,
      checksumText: `${'f'.repeat(64)}  kinetick-code-0.6.0-rc.1.tar.gz\n`,
    });
    const runInstall = vi.fn(async () => undefined);
    await expect(service([entry], { runInstall }).apply({})).rejects.toThrow(
      /checksum verification failed/u,
    );
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('rejects an installation whose version does not match the installed one', async () => {
    const entry = releaseEntry('0.6.0-rc.1', { prerelease: true });
    await expect(
      service([entry], { readInstalledPackageVersion: () => '0.5.9' }).apply({}),
    ).rejects.toThrow(/installed 0\.5\.9; expected 0\.6\.0-rc\.1/u);
  });

  it('does not downgrade an installation without an explicit version', async () => {
    const entry = releaseEntry('0.5.1-rc.1', { prerelease: true });
    await expect(
      service([entry], {}, { currentVersion: '0.5.2' }).apply({}),
    ).rejects.toThrow(/no update was applied/u);
  });

  it('refuses to install on Windows, where no release is validated', async () => {
    const entry = releaseEntry('0.6.0-rc.1', { prerelease: true });
    const runInstall = vi.fn(async () => undefined);
    await expect(
      service([entry], { runInstall }, { platform: 'win32' }).apply({}),
    ).rejects.toThrow(/validated on Linux and macOS only/u);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('reports the public archive URL in the install command for a source checkout', async () => {
    const entry = releaseEntry('0.6.0-rc.1', { prerelease: true });
    const command = await service([entry]).resolveInstallCommand({});
    const name = archiveName('0.6.0-rc.1');
    expect(command).toBe(`npm install --global ${browserUrlOf(entry, name)}`);
    expect(command).not.toContain('api.github.com');
  });

  it('honours cancellation before any download starts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      service([releaseEntry('0.6.0-rc.1', { prerelease: true })]).check({
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(KcodeUpdateCancelledError);
  });

});

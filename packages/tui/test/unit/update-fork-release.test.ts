import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  KCODE_FORK_ARCHIVE_NAMES,
  KCODE_FORK_RELEASES_URL,
  KcodeForkReleaseService,
  buildKcodeForkInstallCommand,
  kcodeForkArchiveNames,
  parseKcodeForkChannel,
  parseKcodeForkChecksum,
  selectKcodeForkRelease,
  usesKcodeForkUpdateSource,
  verifyKcodeForkArtifact,
  type KcodeForkRelease,
  type KcodeForkReleaseDependencies,
} from '../../src/update/fork-release.js';
import { McodeUpdateCancelledError } from '../../src/update/progress.js';

const ARCHIVE_BYTES = Buffer.from('kinetick code release archive bytes');

function archiveName(version: string, prefix = KCODE_FORK_ARCHIVE_NAMES[0]): string {
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

function browserUrlOf(entry: ReturnType<typeof releaseEntry>, name: string): string {
  const found = entry.assets.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`fixture is missing ${name}`);
  return found.browser_download_url;
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
  const assets = [asset(name, bytes.length, tag)];
  if (!options.omitChecksum) {
    assets.push(asset(`${name}.sha256`, (options.checksumText ?? `${digest}  ${name}\n`).length, tag));
  }
  return {
    tag_name: `v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: '2026-09-22T09:43:59Z',
    assets,
    checksumText: options.checksumText ?? `${digest}  ${name}\n`,
    archiveBytes: bytes,
  };
}

function checksumUrlOf(
  entry: { assets: { name: string; url: string }[] },
  archive: string,
): string {
  const found = entry.assets.find((candidate) => candidate.name === `${archive}.sha256`);
  if (!found) throw new Error('fixture is missing the checksum asset');
  return found.url;
}

function artifactUrlOf(
  entry: { assets: { name: string; url: string }[] },
  archive: string,
): string {
  const found = entry.assets.find((candidate) => candidate.name === archive);
  if (!found) throw new Error('fixture is missing the archive asset');
  return found.url;
}

function dependenciesFor(
  entries: ReturnType<typeof releaseEntry>[],
  overrides: Partial<KcodeForkReleaseDependencies> = {},
): KcodeForkReleaseDependencies {
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
        const name = entry.assets[0]?.name;
        if (!name) continue;
        if (url === artifactUrlOf(entry, name)) return entry.archiveBytes;
        if (url === checksumUrlOf(entry, name)) return Buffer.from(entry.checksumText);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
    runInstall: vi.fn(async () => undefined),
    readInstalledPackageVersion: vi.fn(() => undefined),
    ...overrides,
  };
}

function service(
  entries: ReturnType<typeof releaseEntry>[],
  dependencies: Partial<KcodeForkReleaseDependencies> = {},
  options: {
    currentVersion?: string;
    installSource?: 'npm-global' | 'npm-prefix' | 'pnpm-global' | 'unsupported';
    environment?: NodeJS.ProcessEnv;
  } = {},
): KcodeForkReleaseService {
  return new KcodeForkReleaseService({
    currentVersion: options.currentVersion ?? '0.5.2-fork.1',
    installSource: options.installSource ?? 'npm-global',
    platform: 'linux',
    environment: options.environment ?? {},
    dependencies: dependenciesFor(entries, dependencies),
  });
}

describe('Kinetick Code fork release channel', () => {
  it('selects the newest release for the preview channel, including prereleases', () => {
    const release = selectKcodeForkRelease(
      [
        releaseEntry('0.5.2-fork.1', { prerelease: true }),
        releaseEntry('0.5.3-fork.1', { prerelease: true }),
      ],
      { channel: 'preview' },
    );
    expect(release.version).toBe('0.5.3-fork.1');
    expect(release.prerelease).toBe(true);
    expect(release.artifact.name).toBe('kinetick-code-0.5.3-fork.1.tar.gz');
  });

  it('keeps the stable channel on published releases and ignores drafts', () => {
    const release = selectKcodeForkRelease(
      [
        releaseEntry('0.5.3-fork.1', { prerelease: true }),
        releaseEntry('0.5.4', { draft: true }),
        releaseEntry('0.5.2'),
      ],
      { channel: 'stable' },
    );
    expect(release.version).toBe('0.5.2');
    expect(release.prerelease).toBe(false);
  });

  it('accepts the pre-rename minimax-code archive name', () => {
    const release = selectKcodeForkRelease(
      [releaseEntry('0.5.2-fork.1', { prefix: 'minimax-code' })],
      { channel: 'preview' },
    );
    expect(release.artifact.name).toBe('minimax-code-0.5.2-fork.1.tar.gz');
  });

  it('rejects a release whose archive has no published checksum', () => {
    expect(() =>
      selectKcodeForkRelease([releaseEntry('0.5.3-fork.1', { omitChecksum: true })], {
        channel: 'preview',
      }),
    ).toThrow(/without its .*\.sha256 checksum/u);
  });

  it('selects a pinned version and reports the releases page when it is absent', () => {
    const entries = [releaseEntry('0.5.2-fork.1', { prerelease: true })];
    expect(
      selectKcodeForkRelease(entries, { channel: 'preview', version: '0.5.2-fork.1' }).version,
    ).toBe('0.5.2-fork.1');
    expect(() => selectKcodeForkRelease(entries, { channel: 'preview', version: '9.9.9' })).toThrow(
      new RegExp(KCODE_FORK_RELEASES_URL, 'u'),
    );
  });

  it('rejects an unsupported fork channel', () => {
    expect(parseKcodeForkChannel('preview')).toBe('preview');
    expect(parseKcodeForkChannel('stable')).toBe('stable');
    expect(() => parseKcodeForkChannel('beta')).toThrow(/Unsupported KCode fork update channel/u);
  });

  it('parses the published checksum file and refuses a mismatched name', () => {
    const digest = 'a'.repeat(64);
    expect(
      parseKcodeForkChecksum(
        `${digest}  kinetick-code-0.5.3.tar.gz\n`,
        'kinetick-code-0.5.3.tar.gz',
      ),
    ).toBe(digest);
    expect(parseKcodeForkChecksum(`${'b'.repeat(64)}  ./name.tar.gz\n`, 'name.tar.gz')).toBe(
      'b'.repeat(64),
    );
    expect(() =>
      parseKcodeForkChecksum(`${digest}  other-name.tar.gz\n`, 'kinetick-code-0.5.3.tar.gz'),
    ).toThrow(/names other-name\.tar\.gz/u);
    expect(() =>
      parseKcodeForkChecksum('not a digest list\n', 'kinetick-code-0.5.3.tar.gz'),
    ).toThrow(/not a SHA-256 digest list/u);
  });

  it('verifies the archive against the committed digest and size', () => {
    const release: KcodeForkRelease = {
      tag: 'v0.5.3-fork.1',
      version: '0.5.3-fork.1',
      prerelease: true,
      publishedAt: '2026-09-22T09:43:59Z',
      artifact: {
        name: archiveName('0.5.3-fork.1'),
        url: 'https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/archive',
        downloadUrl:
          'https://github.com/tournierjc/kinetick-code/releases/download/v0.5.3-fork.1/' +
          archiveName('0.5.3-fork.1'),
        size: ARCHIVE_BYTES.length,
        checksumUrl: 'https://api.github.com/repos/tournierjc/kinetick-code/releases/assets/checksum',
      },
    };
    const digest = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
    expect(() => verifyKcodeForkArtifact(ARCHIVE_BYTES, release.artifact, digest)).not.toThrow();
    expect(() => verifyKcodeForkArtifact(ARCHIVE_BYTES, release.artifact, 'f'.repeat(64))).toThrow(
      /checksum verification failed/u,
    );
    expect(() =>
      verifyKcodeForkArtifact(
        Buffer.concat([ARCHIVE_BYTES, Buffer.from('extra')]),
        release.artifact,
        digest,
      ),
    ).toThrow(/size verification failed/u);
  });

  it('routes every package-manager installation to the fork channel', () => {
    expect(usesKcodeForkUpdateSource('npm-global')).toBe(true);
    expect(usesKcodeForkUpdateSource('npm-prefix')).toBe(true);
    expect(usesKcodeForkUpdateSource('unsupported')).toBe(true);
    expect(usesKcodeForkUpdateSource('managed-installer')).toBe(false);
    expect(usesKcodeForkUpdateSource('npm-global', { KCODE_UPDATE_SOURCE: 'upstream' })).toBe(
      false,
    );
  });

  it('builds the install command for each owning package manager', () => {
    const archive = '/tmp/kcode-update/kinetick-code-0.5.3-fork.1.tar.gz';
    expect(buildKcodeForkInstallCommand('npm-global', archive, { platform: 'linux' }).args).toEqual(
      expect.arrayContaining(['install', '--global', archive]),
    );
    expect(
      buildKcodeForkInstallCommand('npm-prefix', archive, {
        platform: 'linux',
        prefix: '/opt/kcode',
      }).args,
    ).toEqual(expect.arrayContaining(['install', '--global', '--prefix', '/opt/kcode', archive]));
    expect(() => buildKcodeForkInstallCommand('npm-prefix', archive)).toThrow(
      /prefix ownership metadata is missing/u,
    );
    expect(buildKcodeForkInstallCommand('pnpm-global', archive).args).toEqual(
      expect.arrayContaining(['add', '--global', archive]),
    );
    expect(buildKcodeForkInstallCommand('yarn-global', archive).args).toEqual(
      expect.arrayContaining(['global', 'add', archive]),
    );
    expect(buildKcodeForkInstallCommand('bun-global', archive).args).toEqual(
      expect.arrayContaining(['add', '--global', archive]),
    );
    expect(
      buildKcodeForkInstallCommand('npm-global', archive, { platform: 'win32' }).executable,
    ).toBe('npm.cmd');
  });

  it('reports the newest fork release as available over the GitHub API', async () => {
    const serviceUnderTest = service([
      releaseEntry('0.5.2-fork.1', { prerelease: true }),
      releaseEntry('0.6.0-fork.1', { prerelease: true }),
    ]);
    const result = await serviceUnderTest.check({});
    expect(result.status).toBe('available');
    expect(result.channel).toBe('preview');
    expect(result.latestVersion).toBe('0.6.0-fork.1');
    expect(result.release.artifact.name).toBe('kinetick-code-0.6.0-fork.1.tar.gz');
  });

  it('reports current and ahead states against the fork channel', async () => {
    const entries = [releaseEntry('0.5.2-fork.1', { prerelease: true })];
    await expect(
      service(entries, {}, { currentVersion: '0.5.2-fork.1' }).check({}),
    ).resolves.toMatchObject({ status: 'current' });
    await expect(
      service(entries, {}, { currentVersion: '0.5.3-fork.1' }).check({}),
    ).resolves.toMatchObject({ status: 'ahead' });
  });

  it('installs the verified archive and reports that a restart is required', async () => {
    const entry = releaseEntry('0.6.0-fork.1', { prerelease: true });
    const runInstall = vi.fn(async () => undefined);
    const serviceUnderTest = service([entry], {
      runInstall,
      readInstalledPackageVersion: () => '0.6.0-fork.1',
    });
    const result = await serviceUnderTest.apply({});
    expect(result.applied).toBe(true);
    expect(result.restartRequired).toBe(true);
    expect(runInstall).toHaveBeenCalledTimes(1);
    const [command] = runInstall.mock.calls[0] as unknown as [{ args: string[] }];
    const archiveArgument = command.args.find((argument) => argument.endsWith('.tar.gz')) ?? '';
    expect(archiveArgument).toMatch(/kinetick-code-0\.6\.0-fork\.1\.tar\.gz$/u);
    // The downloaded archive never outlives the update.
    expect(existsSync(archiveArgument)).toBe(false);
  });

  it('refuses to install an archive whose published checksum does not match', async () => {
    const entry = releaseEntry('0.6.0-fork.1', {
      prerelease: true,
      checksumText: `${'f'.repeat(64)}  kinetick-code-0.6.0-fork.1.tar.gz\n`,
    });
    const runInstall = vi.fn(async () => undefined);
    await expect(service([entry], { runInstall }).apply({})).rejects.toThrow(
      /checksum verification failed/u,
    );
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('refuses to update an installation it cannot validate or own', async () => {
    const entry = releaseEntry('0.6.0-fork.1', { prerelease: true });
    await expect(service([entry], {}, { installSource: 'unsupported' }).apply({})).rejects.toThrow(
      /cannot update this installation automatically/u,
    );
  });

  it('does not downgrade an installation without an explicit version', async () => {
    const entry = releaseEntry('0.5.1-fork.1', { prerelease: true });
    await expect(
      service([entry], {}, { currentVersion: '0.5.2-fork.1' }).apply({}),
    ).rejects.toThrow(/no update was applied/u);
  });

  it('reports the public archive URL in the fork install command for a source checkout', async () => {
    const entry = releaseEntry('0.6.0-fork.1', { prerelease: true });
    const command = await service(
      [entry],
      {},
      { installSource: 'unsupported' },
    ).resolveInstallCommand({});
    const name = archiveName('0.6.0-fork.1');
    expect(command).toBe(`npm install --global ${browserUrlOf(entry, name)}`);
    expect(command).not.toContain('api.github.com');
  });

  it('honours cancellation before any download starts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      service([releaseEntry('0.6.0-fork.1', { prerelease: true })]).check({
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(McodeUpdateCancelledError);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => fakeHome.dir };
});

const { ensurePathIntegration } = await import('../../../src/infra/ensure-path-integration.js');
const { RM_SHIM_CONTENT, ensureRmShim, resolveRmShimDir } = await import(
  '../../../src/infra/ensure-rm-shim.js'
);

const roots: string[] = [];

beforeEach(() => {
  fakeHome.dir = mkdtempSync(join(tmpdir(), 'kcode-home-'));
  roots.push(fakeHome.dir);
});

function makeRoot(): string {
  const root = mkdtempSync(join(fakeHome.dir, 'kcode-infra-'));
  roots.push(root);
  return root;
}

/** Runs `body` with `process.platform` reporting `platform`. */
async function withPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await body();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('KCode shell PATH integration marker', () => {
  it('writes the fork marker and the data-dir bin export into the user shell profile', async () => {
    const dataDir = makeRoot();

    ensurePathIntegration(dataDir);

    const rc = readFileSync(join(fakeHome.dir, '.bashrc'), 'utf8');
    expect(rc).toContain('# Added by Kinetick Code');
    expect(rc).toContain(`export PATH="${join(dataDir, 'bin')}:$PATH"`);
    expect(rc).not.toContain('MiniMax');
  });

  it('does not append a second block when the fork marker is already present', async () => {
    const dataDir = makeRoot();
    const rcPath = join(fakeHome.dir, '.bashrc');
    writeFileSync(rcPath, '# existing\nexport PATH="/opt/other/bin:$PATH"\n');

    ensurePathIntegration(dataDir);
    const once = readFileSync(rcPath, 'utf8');
    ensurePathIntegration(dataDir);

    expect(readFileSync(rcPath, 'utf8')).toBe(once);
    expect(once.match(/# Added by Kinetick Code/gu)).toHaveLength(1);
  });

  it('recognizes the marker an earlier release wrote instead of duplicating the export', async () => {
    const dataDir = makeRoot();
    const rcPath = join(fakeHome.dir, '.bashrc');
    const legacy = `\n# Added by MiniMax Code\nexport PATH="${join(dataDir, 'bin')}:$PATH"\n`;
    writeFileSync(rcPath, legacy);

    ensurePathIntegration(dataDir);

    expect(readFileSync(rcPath, 'utf8')).toBe(legacy);
  });

  it('updates both macOS shell profiles', async () => {
    const dataDir = makeRoot();

    await withPlatform('darwin', async () => {
      ensurePathIntegration(dataDir);
    });

    for (const rc of ['.zshrc', '.bashrc']) {
      expect(readFileSync(join(fakeHome.dir, rc), 'utf8')).toContain('# Added by Kinetick Code');
    }
  });
});

describe('KCode recoverable-delete rm shim', () => {
  it('seeds an executable shim that names this product and delegates to mavis-trash', () => {
    const dataDir = makeRoot();

    const shimDir = ensureRmShim(dataDir, 'linux');

    expect(shimDir).toBe(resolveRmShimDir(dataDir));
    const shimPath = join(dataDir, 'shims', 'rm');
    expect(existsSync(shimPath)).toBe(true);
    expect(readFileSync(shimPath, 'utf8')).toBe(RM_SHIM_CONTENT);
    expect(RM_SHIM_CONTENT.startsWith('#!/bin/bash\n# Managed by Kinetick Code. Do not edit.\n')).toBe(
      true,
    );
    expect(RM_SHIM_CONTENT).toContain('trash_bin="$shim_dir/../bin/mavis-trash"');
  });

  it('rewrites a shim written by an earlier release so the header tracks this product', () => {
    const dataDir = makeRoot();
    mkdirSync(resolveRmShimDir(dataDir), { recursive: true });
    const shimPath = join(dataDir, 'shims', 'rm');
    writeFileSync(shimPath, RM_SHIM_CONTENT.replace('# Managed by Kinetick Code', '# Managed by MiniMax Code'));

    ensureRmShim(dataDir, 'linux');

    expect(readFileSync(shimPath, 'utf8')).toBe(RM_SHIM_CONTENT);
  });

  it('installs no shim on Windows, where rm resolves through PowerShell aliases', () => {
    const dataDir = makeRoot();

    expect(ensureRmShim(dataDir, 'win32')).toBeUndefined();
    expect(existsSync(resolveRmShimDir(dataDir))).toBe(false);
  });
});

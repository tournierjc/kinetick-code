import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_DATA_DIR_BASENAME,
  LEGACY_DATA_DIR_BASENAMES,
  NEW_DATA_DIR_BASENAME,
  getLegacyDataDirPath,
  getPrimaryDataDirPath,
  resolveDataDir,
} from '../src/data-dir.js';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetick-data-dir-'));
  cleanup.push(home);
  return home;
}

describe('data directory basenames', () => {
  it('defaults to .kinetick with .minimax as the newest legacy basename', () => {
    expect(NEW_DATA_DIR_BASENAME).toBe('.kinetick');
    expect(LEGACY_DATA_DIR_BASENAME).toBe('.minimax');
    expect([...LEGACY_DATA_DIR_BASENAMES]).toEqual(['.minimax', '.mavis']);
  });

  it('builds primary and legacy paths with optional profiles', () => {
    expect(getPrimaryDataDirPath('/home/dev')).toBe(path.join('/home/dev', '.kinetick'));
    expect(getPrimaryDataDirPath('/home/dev', 'smoke')).toBe(
      path.join('/home/dev', '.kinetick-smoke'),
    );
    expect(getLegacyDataDirPath('/home/dev')).toBe(path.join('/home/dev', '.minimax'));
    expect(getLegacyDataDirPath('/home/dev', 'smoke')).toBe(
      path.join('/home/dev', '.minimax-smoke'),
    );
  });
});

describe('resolveDataDir migration', () => {
  it('creates ~/.kinetick when no legacy data exists', () => {
    const home = tempHome();
    const resolved = resolveDataDir({ homeDir: home });
    expect(resolved).toBe(path.join(home, '.kinetick'));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it('migrates ~/.minimax into ~/.kinetick and leaves a compat link', () => {
    const home = tempHome();
    const legacy = path.join(home, '.minimax');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'logLevel: info\n');

    const resolved = resolveDataDir({ homeDir: home });
    expect(resolved).toBe(path.join(home, '.kinetick'));
    expect(fs.readFileSync(path.join(resolved, 'config.yaml'), 'utf8')).toBe('logLevel: info\n');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(legacy, 'config.yaml'), 'utf8')).toBe('logLevel: info\n');
  });

  it('migrates ~/.mavis when ~/.minimax is absent', () => {
    const home = tempHome();
    const legacy = path.join(home, '.mavis');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'logLevel: warn\n');

    const resolved = resolveDataDir({ homeDir: home });
    expect(resolved).toBe(path.join(home, '.kinetick'));
    expect(fs.readFileSync(path.join(resolved, 'config.yaml'), 'utf8')).toBe('logLevel: warn\n');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
  });

  it('prefers existing ~/.kinetick over legacy directories', () => {
    const home = tempHome();
    const primary = path.join(home, '.kinetick');
    const legacy = path.join(home, '.minimax');
    fs.mkdirSync(primary);
    fs.writeFileSync(path.join(primary, 'config.yaml'), 'logLevel: error\n');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'logLevel: info\n');

    const resolved = resolveDataDir({ homeDir: home });
    expect(resolved).toBe(primary);
    expect(fs.readFileSync(path.join(primary, 'config.yaml'), 'utf8')).toBe('logLevel: error\n');
  });
});

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getTuiDataDirPath,
  prepareTuiDataDir,
  resolveDefaultTuiDataDir,
} from '../../src/runtime/data-dir.js';

describe('TUI data directory', () => {
  it.each(['dev', 'test', 'staging', 'prod'] as const)(
    'uses the shared user directory for %s builds',
    (buildEnv) => {
      expect(resolveDefaultTuiDataDir(buildEnv, undefined, () => null)).toBe(
        join(homedir(), '.kinetick'),
      );
    },
  );

  it('keeps the shared profile suffix', () => {
    expect(resolveDefaultTuiDataDir('prod', undefined, () => 'smoke')).toBe(
      join(homedir(), '.kinetick-smoke'),
    );
  });

  it.each([
    [{}, '/default'],
    [{ KINETICK_DATA_DIR: '  ', MINIMAX_DATA_DIR: '  ', MAVIS_DATA_DIR: ' ' }, '/default'],
    [
      { KINETICK_DATA_DIR: ' /kinetick ', MINIMAX_DATA_DIR: '/public', MAVIS_DATA_DIR: '/legacy' },
      '/kinetick',
    ],
    [{ MINIMAX_DATA_DIR: ' /public ', MAVIS_DATA_DIR: '/legacy' }, '/public'],
    [{ MINIMAX_DATA_DIR: ' ', MAVIS_DATA_DIR: ' /legacy ' }, '/legacy'],
  ])('preserves override precedence for %j', (environment, expected) => {
    expect(getTuiDataDirPath(environment, () => '/default')).toBe(expected);
  });

  it('passes the selected directory to runtime initialization', async () => {
    const configureRuntimeEnvironment = vi.fn();
    await expect(prepareTuiDataDir({
      environment: { KINETICK_DATA_DIR: ' /selected ' },
      getBuildEnv: () => 'prod',
      configureRuntimeEnvironment,
    })).resolves.toBe('/selected');
    expect(configureRuntimeEnvironment).toHaveBeenCalledWith({ dataDir: '/selected' });
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { buildMcpStdioChildEnv } from '../src/runtime/transport/stdio.js';

describe('MCP stdio child environment', () => {
  const previous = process.env.MAVIS_ACCESS_TOKEN;
  const previousDataDir = process.env.KINETICK_DATA_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.MAVIS_ACCESS_TOKEN;
    else process.env.MAVIS_ACCESS_TOKEN = previous;
    if (previousDataDir === undefined) delete process.env.KINETICK_DATA_DIR;
    else process.env.KINETICK_DATA_DIR = previousDataDir;
  });

  it('drops runtime boundary keys even when the MCP config copies them', () => {
    process.env.MAVIS_ACCESS_TOKEN = 'parent-token';
    process.env.KINETICK_DATA_DIR = '/tmp/kinetick-data';
    const env = buildMcpStdioChildEnv(
      { MAVIS_ACCESS_TOKEN: 'from-config', KEEP: 'yes' },
      { KINETICK_DATA_DIR: 'from-injected' },
    );
    expect(env.MAVIS_ACCESS_TOKEN).toBeUndefined();
    expect(env.KINETICK_DATA_DIR).toBeUndefined();
    expect(env.KEEP).toBe('yes');
  });
});

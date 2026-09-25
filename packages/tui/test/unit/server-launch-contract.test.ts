import { describe, expect, it, vi } from 'vitest';

import { createTuiProgram } from '../../src/cli/program.js';
import {
  DEFAULT_TUI_SERVER_HOST,
  DEFAULT_TUI_SERVER_PORT,
} from '../../src/server/http.js';

describe('session server launch contract', () => {
  function program() {
    const launchTui = vi.fn(async () => undefined);
    const runServer = vi.fn(async () => undefined);
    const command = createTuiProgram({
      version: 'test',
      launchTui,
      runServer,
      runExec: vi.fn(),
      runLogin: vi.fn(),
      runLogout: vi.fn(),
      runUpdate: vi.fn(),
    })
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    return { command, launchTui, runServer };
  }

  it('starts the session server with default host and port', async () => {
    const { command, launchTui, runServer } = program();
    await command.parseAsync(['--server'], { from: 'user' });
    expect(runServer).toHaveBeenCalledTimes(1);
    expect(runServer).toHaveBeenCalledWith({ host: DEFAULT_TUI_SERVER_HOST, port: DEFAULT_TUI_SERVER_PORT });
    expect(launchTui).not.toHaveBeenCalled();
  });

  it('forwards an explicit host and port for external connections', async () => {
    const { command, runServer } = program();
    await command.parseAsync(['--server', '--host', '0.0.0.0', '--port', '9430'], {
      from: 'user',
    });
    expect(runServer).toHaveBeenCalledWith({ host: '0.0.0.0', port: 9430 });
  });

  it.each([
    ['a prompt argument', ['--server', 'hello']],
    ['--model', ['--server', '--model', 'provider/model']],
    ['--session', ['--server', '--session', 'session-1']],
    ['--continue', ['--server', '--continue']],
    ['--resume', ['--server', '--resume', 'session-1']],
    ['--tui-mode', ['--server', '--tui-mode', 'fullscreen']],
  ])('rejects --server combined with %s', async (_label: string, argv: string[]) => {
    const { command, launchTui, runServer } = program();
    await expect(command.parseAsync(argv, { from: 'user' })).rejects.toThrow(
      '--server cannot be combined with',
    );
    expect(runServer).not.toHaveBeenCalled();
    expect(launchTui).not.toHaveBeenCalled();
  });

  it.each([
    ['0', '--port', '0'],
    ['out of range', '--port', '65536'],
    ['non numeric', '--port', 'http'],
  ])('rejects an invalid port %s', async (_label: string, flag: string, value: string) => {
    const { command, runServer } = program();
    await expect(
      command.parseAsync(['--server', flag, value], { from: 'user' }),
    ).rejects.toThrow('expected a port between 1 and 65535');
    expect(runServer).not.toHaveBeenCalled();
  });

  it('keeps the default launch contract without --server', async () => {
    const { command, launchTui, runServer } = program();
    await command.parseAsync(['hello'], { from: 'user' });
    expect(launchTui).toHaveBeenCalledWith({ initialPrompt: 'hello' });
    expect(runServer).not.toHaveBeenCalled();
  });

  it('ignores host and port without --server', async () => {
    const { command, launchTui, runServer } = program();
    await command.parseAsync(['--port', '9430'], { from: 'user' });
    expect(launchTui).toHaveBeenCalledWith({});
    expect(runServer).not.toHaveBeenCalled();
  });

  it('fails when no session server runner is available', async () => {
    const command = createTuiProgram({
      version: 'test',
      launchTui: vi.fn(async () => undefined),
      runExec: vi.fn(),
      runLogin: vi.fn(),
      runLogout: vi.fn(),
      runUpdate: vi.fn(),
    })
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    await expect(command.parseAsync(['--server'], { from: 'user' })).rejects.toThrow(
      'Session server is unavailable.',
    );
  });
});

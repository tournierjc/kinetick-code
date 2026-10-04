/**
 * Stdio MCP transport for Mavis runtimes.
 *
 * Ported from the retired `packages/daemon/src/mcp/runtime/transport/stdio.ts`,
 * narrowed to the surface Mavis runtimes need:
 *
 *   * `cwd: homedir()` — never inherit launchd / Electron / systemd CWD (which
 *     can be `/`), so MCP children that write workspace-relative dirs
 *     (such as Playwright's `.playwright-mcp/`) don't
 *     ENOENT against `/`.
 *   * `stderr: 'pipe'` — the SDK creates a PassThrough but no consumer
 *     attaches by default. The connection pool's `attachStderrLogging` reads
 *     this stream and emits per-line log records; without `'pipe'` here that
 *     hook would silently no-op. We also attach an error handler to the raw
 *     child stderr pipe because Node does not forward source stream errors
 *     through `.pipe()`.
 *   * `env` starts from the parent environment, then config and injected
 *     values. Runtime boundary keys (access tokens, data-directory pointers,
 *     parent session identity) are removed after that merge, so a project
 *     config cannot copy them back in.
 */
import { homedir } from 'node:os';
import { stripRuntimeBoundaryKeysFrom } from '@mavis/shared/runtime-boundary-env';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { StdioTransportConfig } from '../types.js';

export interface McpStdioTransportOptions {
  env?: Record<string, string>;
}

export function createStdioTransport(
  config: StdioTransportConfig,
  options?: McpStdioTransportOptions,
): Transport {
  return new SafeStdioClientTransport({
    command: config.command,
    args: config.args,
    env: buildMcpStdioChildEnv(config.env, options?.env),
    cwd: config.cwd ?? homedir(),
    stderr: 'pipe',
  });
}

class SafeStdioClientTransport extends StdioClientTransport {
  override async start(): Promise<void> {
    await super.start();
    const childProcess = (
      this as unknown as {
        _process?: { stderr?: NodeJS.ReadableStream | null };
      }
    )._process;
    childProcess?.stderr?.on?.('error', (error: Error) => {
      this.onerror?.(error);
    });
  }
}

export function buildMcpStdioChildEnv(
  configEnv?: Record<string, string>,
  injectedEnv?: Record<string, string>,
): Record<string, string> {
  const merged: NodeJS.ProcessEnv = {
    ...getProcessEnv(),
    ...(configEnv ?? {}),
    ...(injectedEnv ?? {}),
  };
  stripRuntimeBoundaryKeysFrom(merged, 'agent-runtime');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function getProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

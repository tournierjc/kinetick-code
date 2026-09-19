import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALWAYS_DENIED_HOSTS,
  EgressBlockedError,
  REPORTING_HOSTS,
  installEgressGuard,
  isEgressBlocked,
  isEgressBlockedError,
  resolveEgressMode,
  resolveEgressPolicy,
  type EgressGuard,
} from '@mavis/shared/egress-guard';

import {
  installTuiEgressGuard,
  resetTuiEgressGuardForTest,
} from '../../src/runtime/egress-guard.js';

const installed: EgressGuard[] = [];

function install(options: Parameters<typeof installEgressGuard>[0]): EgressGuard {
  const guard = installEgressGuard(options);
  installed.push(guard);
  return guard;
}

afterEach(() => {
  while (installed.length > 0) installed.pop()?.uninstall();
  resetTuiEgressGuardForTest();
});

describe('egress policy', () => {
  it('defaults to managed-deny and only accepts the documented modes', () => {
    expect(resolveEgressMode(undefined)).toBe('managed-deny');
    expect(resolveEgressMode('')).toBe('managed-deny');
    expect(resolveEgressMode('nonsense')).toBe('managed-deny');
    expect(resolveEgressMode('allowlist')).toBe('allowlist');
    expect(resolveEgressMode('off')).toBe('off');
    expect(resolveEgressPolicy({}).mode).toBe('managed-deny');
    expect(resolveEgressPolicy({ MCODE_EGRESS_MODE: 'off' }).mode).toBe('off');
  });

  it('refuses every managed-service and reporting host by default', () => {
    const policy = resolveEgressPolicy({});
    expect(REPORTING_HOSTS.every((host) => (ALWAYS_DENIED_HOSTS as readonly string[]).includes(host))).toBe(true);
    for (const host of ALWAYS_DENIED_HOSTS) {
      expect(isEgressBlocked(policy, { protocol: 'https', hostname: host })).toBe(true);
    }
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'agent.minimax.io' })).toBe(true);
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'data.hailuo.ai' })).toBe(true);
  });

  it('keeps loopback and unrelated third-party endpoints reachable', () => {
    const policy = resolveEgressPolicy({});
    for (const hostname of ['127.0.0.1', 'localhost', '::1']) {
      expect(isEgressBlocked(policy, { protocol: 'http', hostname, port: 8080 })).toBe(false);
    }
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'api.openai.com' })).toBe(false);
  });

  it('refuses the MiniMax model API unless the user declared that provider', () => {
    const strict = resolveEgressPolicy({});
    expect(isEgressBlocked(strict, { protocol: 'https', hostname: 'api.minimax.io' })).toBe(true);

    const declared = resolveEgressPolicy({}, { providerOrigins: ['https://api.minimax.io/v1'] });
    expect(isEgressBlocked(declared, { protocol: 'https', hostname: 'api.minimax.io' })).toBe(false);
    // Declaring one provider must not unlock a managed service host.
    expect(isEgressBlocked(declared, { protocol: 'https', hostname: 'agent.minimax.io' })).toBe(true);
  });

  it('allowlist mode reaches loopback, declared providers, and nothing else', () => {
    const policy = resolveEgressPolicy(
      {
        MCODE_EGRESS_MODE: 'allowlist',
        MCODE_ALLOWED_ORIGINS: 'example.test, https://extra.test:8443',
      },
      { providerOrigins: ['https://api.openai.com'] },
    );
    expect(isEgressBlocked(policy, { protocol: 'http', hostname: '127.0.0.1' })).toBe(false);
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'api.openai.com' })).toBe(false);
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'example.test' })).toBe(false);
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'extra.test', port: 8443 })).toBe(false);
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'extra.test', port: 9999 })).toBe(true);
    expect(isEgressBlocked(policy, { protocol: 'https', hostname: 'api.unknown.test' })).toBe(true);
  });
});

describe('egress enforcement', () => {
  it('refuses a blocked fetch before the transport sees it', async () => {
    const underlying = vi.fn(async () => new Response('unreachable'));
    const guard = install({
      environment: {},
      fetchImpl: underlying as unknown as typeof globalThis.fetch,
    });

    await expect(fetch('https://data.hailuo.ai/meerkat-reporter/api/report')).rejects.toThrow(
      EgressBlockedError,
    );
    await expect(
      fetch('https://agent.minimax.io/minimax-cloud/api/v1/signin/status'),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.denials).toHaveLength(2);
    expect(guard.denials[0]?.hostname).toBe('data.hailuo.ai');
    expect(isEgressBlockedError(new EgressBlockedError(guard.denials[0]!))).toBe(true);
  });

  it('delegates an allowed fetch to the transport', async () => {
    const underlying = vi.fn(async () => new Response('ok'));
    install({ environment: {}, fetchImpl: underlying as unknown as typeof globalThis.fetch });
    const response = await fetch('https://api.openai.com/v1/models');
    expect(await response.text()).toBe('ok');
    expect(underlying).toHaveBeenCalledOnce();
  });

  it('delegates an allowed socket and refuses a blocked one', async () => {
    const originalConnect = vi.fn();
    const socketPrototype = { connect: originalConnect };
    const guard = install({ environment: {}, socketPrototype });
    const patched = socketPrototype.connect as unknown as (...args: unknown[]) => unknown;
    const socket = new EventEmitter() as EventEmitter & { destroyed?: boolean };
    const errors: unknown[] = [];
    socket.on('error', (error) => errors.push(error));

    patched.call(socket, { host: 'api.openai.com', port: 443 });
    expect(originalConnect).toHaveBeenCalledOnce();

    patched.call(socket, { host: 'data.hailuoai.com', port: 443 });
    expect(originalConnect).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EgressBlockedError);
    expect(guard.denials).toHaveLength(1);
    expect(socket.destroyed).not.toBe(true);
  });

  it('reports a blocked socket the way Node reports a failed connect', async () => {
    const guard = install({ environment: {} });
    const socket = new Socket();
    const error = await new Promise<unknown>((resolve) => {
      socket.on('error', resolve);
      socket.connect({ host: 'agent.minimax.cn', port: 443 });
    });
    expect(error).toBeInstanceOf(EgressBlockedError);
    expect((error as EgressBlockedError).hostname).toBe('agent.minimax.cn');
    socket.destroy();
    expect(guard.denials).toHaveLength(1);
  });

  it('leaves local traffic working end to end', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('local-fixture');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = install({ environment: {} });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe('local-fixture');
      expect(guard.denials).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('restores the original transport on uninstall', () => {
    const originalFetch = globalThis.fetch;
    const guard = install({ environment: {} });
    expect(globalThis.fetch).not.toBe(originalFetch);
    guard.uninstall();
    installed.pop();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('does not patch anything when the mode is off', () => {
    const originalFetch = globalThis.fetch;
    const guard = install({ environment: { MCODE_EGRESS_MODE: 'off' } });
    expect(guard.policy.mode).toBe('off');
    expect(globalThis.fetch).toBe(originalFetch);
  });
});

describe('TUI egress guard wiring', () => {
  it('derives provider origins from the config seam and installs once', async () => {
    const resolveProviderOrigins = vi.fn(() => ['https://api.myprovider.test/v1']);
    const guard = await installTuiEgressGuard({ environment: {}, resolveProviderOrigins });
    expect(guard).toBeDefined();
    expect(resolveProviderOrigins).toHaveBeenCalledOnce();
    expect(guard!.isBlocked({ protocol: 'https', hostname: 'api.myprovider.test' })).toBe(false);
    expect(guard!.isBlocked({ protocol: 'https', hostname: 'agent.minimax.io' })).toBe(true);

    const again = await installTuiEgressGuard({ environment: {}, resolveProviderOrigins });
    expect(again).toBe(guard);
    expect(resolveProviderOrigins).toHaveBeenCalledOnce();
  });
});

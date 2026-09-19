/**
 * Default-deny egress guard.
 *
 * This fork ships without any automatic reporting, so the guard exists to make
 * that property structural rather than a matter of which code paths happen to
 * be reachable today: every outbound TCP connection the process attempts is
 * checked against a policy before Node opens a socket.
 *
 * Two chokepoints are patched, because no single one covers the codebase:
 *
 *   - `globalThis.fetch` — the surface used by first-party request helpers, so a
 *     refused call fails with a named error instead of a transport error.
 *   - `net.Socket.prototype.connect` — the surface every higher-level client
 *     ultimately uses, including `undici`'s own `fetch` export (which is not
 *     `globalThis.fetch`), `node:http`/`node:https`, and `node:tls`.
 *
 * A blocked connection is reported the way Node reports a failed one: the
 * socket emits `error` on the next tick and never connects. Callers therefore
 * observe an ordinary connection failure, and no bytes leave the machine.
 *
 * Modes:
 *   - `managed-deny` (default) — loopback and provider endpoints stay usable;
 *     the MiniMax managed-service and reporting hosts below are refused.
 *   - `allowlist` — only loopback, the caller-supplied provider origins, and
 *     explicit `allowHosts` entries are reachable.
 *   - `off` — no enforcement. Explicit opt-out only.
 *
 * Boundaries: the policy matches on hostname, not on resolved IP, so a process
 * that resolves a name itself and dials the address directly, or that routes
 * through a SOCKS/TUN proxy, is not covered. Unix-domain sockets are local IPC
 * and are allowed. IP literals are matched only against the loopback test.
 *
 * A refused `Socket.connect` is reported the way `undici`, `node:http` and
 * `node:tls` expect — the socket emits `error` on a microtask and never connects
 * — but the socket object itself is left untouched: it is not marked
 * `connecting` and not destroyed. A caller that inspects socket state, or that
 * attaches its `error` listener after `connect()` returns, therefore learns
 * nothing from the socket. With no `error` listener the throw surfaces as an
 * uncaught exception, exactly as a real failed connect does. Refusals are
 * recorded on the guard (`denials`, `onBlocked`), which is where a caller should
 * read them from; the socket is only how the failure reaches the client above it.
 */

import { Socket } from 'node:net';

const ENV_EGRESS_MODE = 'MCODE_EGRESS_MODE';
const ENV_ALLOWED_ORIGINS = 'MCODE_ALLOWED_ORIGINS';

/** Reporting/analytics hosts. Never contacted by this fork. */
export const REPORTING_HOSTS = [
  'data.hailuo.ai',
  'data.hailuoai.com',
  'bigdata-test.talkie-ai.com',
  'bigdata-test.xingyeai.com',
] as const;

/**
 * MiniMax managed-service hosts: login, managed models, cloud tools, hub, plus
 * the Aliyun Shanghai bucket the managed file service writes through.
 *
 * Membership test: a host belongs here only when it is a MiniMax-managed
 * endpoint this fork refuses to contact. A third-party service does not, however
 * central it looks. The `models.dev` provider catalog is the example that
 * matters: it serves the model-preset catalog from a public community project,
 * so it is an ordinary endpoint and the mode governs it like any other —
 * reachable in `managed-deny`, refused in `allowlist` unless listed in
 * `MCODE_ALLOWED_ORIGINS`. It was listed here while the preset catalog was
 * disabled, which made a community service look like a MiniMax one to readers.
 */
export const MANAGED_SERVICE_HOSTS = [
  'agent.minimax.io',
  'agent.minimax.cn',
  'agent.minimaxi.com',
  'account.minimax.io',
  'account.minimax.cn',
  'platform.minimax.io',
  'www.minimaxi.com',
  'filecdn.minimax.chat',
  'algeng-ali-shanghai-agent-02.oss-cn-shanghai.aliyuncs.com',
] as const;

/**
 * MiniMax model API endpoints. These are an ordinary BYOK model endpoint, so
 * they are reachable only when the user declared a provider on that origin.
 */
export const MANAGED_MODEL_API_HOSTS = ['api.minimax.io', 'api.minimaxi.com'] as const;

/**
 * Hosts refused in every mode except `off`. Kept separate from the model API
 * list so a configuration change can never re-open a managed or reporting
 * endpoint.
 */
export const ALWAYS_DENIED_HOSTS = [...REPORTING_HOSTS, ...MANAGED_SERVICE_HOSTS] as const;

export type EgressMode = 'managed-deny' | 'allowlist' | 'off';

export interface EgressDecisionInput {
  readonly protocol: string;
  readonly hostname: string;
  readonly port?: number;
}

export interface EgressAttempt extends EgressDecisionInput {
  readonly reason: string;
}

export interface EgressPolicy {
  readonly mode: EgressMode;
  /** Extra reachable hosts, matched on hostname and optionally `host:port`. */
  readonly allowHosts: readonly string[];
  /** Origins the user configured as model providers. */
  readonly providerOrigins: readonly string[];
  /** Extra refused hosts, applied in every mode except `off`. */
  readonly denyHosts: readonly string[];
}

export interface EgressGuard {
  readonly policy: EgressPolicy;
  /** Refused attempts, most recent last. Bounded by `denialLimit`. */
  readonly denials: readonly EgressAttempt[];
  isBlocked(input: EgressDecisionInput): boolean;
  uninstall(): void;
}

export interface InstallEgressGuardOptions extends Partial<EgressPolicy> {
  readonly environment?: Record<string, string | undefined>;
  readonly onBlocked?: (attempt: EgressAttempt) => void;
  /** Diagnostics retention for `denials`; default 64. */
  readonly denialLimit?: number;
  /** Test seams. */
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly socketPrototype?: { connect: (...args: unknown[]) => unknown };
}

export class EgressBlockedError extends Error {
  readonly code = 'MCODE_EGRESS_BLOCKED';
  readonly hostname: string;
  readonly port?: number;

  constructor(attempt: EgressAttempt) {
    super(
      `Blocked outbound connection to ${attempt.protocol}//${attempt.hostname}` +
        `${attempt.port ? `:${attempt.port}` : ''} — ${attempt.reason}`,
    );
    this.name = 'EgressBlockedError';
    this.hostname = attempt.hostname;
    if (attempt.port !== undefined) this.port = attempt.port;
  }
}

export function isEgressBlockedError(value: unknown): value is EgressBlockedError {
  return value instanceof EgressBlockedError;
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  return ipv4?.[1] === '127';
}

/** Accepts `host`, `host:port`, `http(s)://host[:port][/path]`, or a bare origin. */
function toHostEntry(value: string): { host: string; port?: string } | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return undefined;
    return {
      host: normalizeHost(parsed.hostname),
      ...(parsed.port ? { port: parsed.port } : {}),
    };
  } catch {
    return undefined;
  }
}

export function parseHostList(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    const entry = toHostEntry(value);
    return entry ? [entry.port ? `${entry.host}:${entry.port}` : entry.host] : [];
  });
}

export function parseAllowedOriginList(value: string | undefined): string[] {
  return parseHostList((value ?? '').split(','));
}

export function resolveEgressMode(value: string | undefined): EgressMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'allowlist') return normalized;
  if (normalized === 'managed-deny') return 'managed-deny';
  return 'managed-deny';
}

export function resolveEgressPolicy(
  environment: Record<string, string | undefined> = process.env,
  overrides: Partial<EgressPolicy> = {},
): EgressPolicy {
  return {
    mode: overrides.mode ?? resolveEgressMode(environment[ENV_EGRESS_MODE]),
    allowHosts: [
      ...(overrides.allowHosts ?? []),
      ...parseAllowedOriginList(environment[ENV_ALLOWED_ORIGINS]),
    ],
    providerOrigins: parseHostList(overrides.providerOrigins ?? []),
    denyHosts: [...(overrides.denyHosts ?? [])],
  };
}

function matchesEntry(hostname: string, port: number | undefined, entry: string): boolean {
  const parsed = toHostEntry(entry);
  if (!parsed || parsed.host !== hostname) return false;
  return parsed.port === undefined || parsed.port === String(port ?? '');
}

/**
 * Pure policy decision, exported so both the guard and its tests can reason
 * about reachability without opening a socket.
 */
export function isEgressBlocked(policy: EgressPolicy, input: EgressDecisionInput): boolean {
  if (policy.mode === 'off') return false;
  const hostname = normalizeHost(input.hostname);
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) return false;

  const denied = (host: string) =>
    (ALWAYS_DENIED_HOSTS as readonly string[]).includes(host) ||
    policy.denyHosts.some((entry) => matchesEntry(hostname, input.port, entry));

  if (denied(hostname)) return true;

  const providedByUser = policy.providerOrigins.some((entry) =>
    matchesEntry(hostname, input.port, entry),
  );
  const explicitlyAllowed = policy.allowHosts.some((entry) =>
    matchesEntry(hostname, input.port, entry),
  );

  if ((MANAGED_MODEL_API_HOSTS as readonly string[]).includes(hostname)) {
    // The MiniMax model API is an ordinary BYOK endpoint: reachable only when
    // the user declared that provider, or allowlisted it on purpose.
    return !(providedByUser || explicitlyAllowed);
  }

  if (policy.mode === 'allowlist') return !(providedByUser || explicitlyAllowed);
  return false;
}

function resolveSocketTarget(
  args: readonly unknown[],
): { hostname: string; port: number | undefined } | undefined {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; hostname?: unknown; path?: unknown };
    // A unix-domain socket is local IPC, not egress.
    if (options.path !== undefined) return undefined;
    const host = options.host ?? options.hostname;
    if (typeof host === 'string' && host) {
      return { hostname: host, port: undefined };
    }
    // No host: Node defaults to localhost.
    return undefined;
  }
  if (typeof first === 'number' && typeof second === 'string') {
    return { hostname: second, port: first };
  }
  return undefined;
}

export function installEgressGuard(options: InstallEgressGuardOptions = {}): EgressGuard {
  const environment = options.environment ?? process.env;
  const policy = resolveEgressPolicy(environment, options);
  const denials: EgressAttempt[] = [];
  const denialLimit = options.denialLimit ?? 64;
  const onBlocked = options.onBlocked;
  const previousFetch = globalThis.fetch;
  const fetchImpl = options.fetchImpl ?? previousFetch;
  const socketPrototype =
    options.socketPrototype ?? (Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown });
  const originalSocketConnect = socketPrototype.connect;
  const guard: EgressGuard = {
    policy,
    denials,
    isBlocked: (input) => isEgressBlocked(policy, input),
    uninstall: () => undefined,
  };

  if (policy.mode === 'off' || !fetchImpl) return guard;

  const record = (input: EgressDecisionInput, reason: string): EgressBlockedError => {
    const attempt: EgressAttempt = { ...input, hostname: normalizeHost(input.hostname), reason };
    denials.push(attempt);
    if (denials.length > denialLimit) denials.shift();
    try {
      onBlocked?.(attempt);
    } catch {
      // A diagnostics sink must never change the outcome of a refused call.
    }
    return new EgressBlockedError(attempt);
  };

  const reasonFor = (input: EgressDecisionInput): string => {
    if ((ALWAYS_DENIED_HOSTS as readonly string[]).includes(normalizeHost(input.hostname)))
      return 'host is a managed-service or reporting endpoint disabled in this fork';
    if (policy.mode === 'allowlist')
      return `host is not in the egress allowlist (${ENV_ALLOWED_ORIGINS})`;
    return 'host is not an allowed egress target';
  };

  globalThis.fetch = ((input: FetchInput, init?: Parameters<typeof globalThis.fetch>[1]) => {
    const resolved = resolveFetchUrl(input);
    if (resolved && guard.isBlocked(resolved)) {
      return Promise.reject(record(resolved, reasonFor(resolved)));
    }
    return fetchImpl(input, init);
  }) as typeof globalThis.fetch;

  socketPrototype.connect = function patchedSocketConnect(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const target = resolveSocketTarget(args);
    if (target && guard.isBlocked({ protocol: 'tcp', ...target })) {
      const error = record({ protocol: 'tcp', ...target }, reasonFor({ protocol: 'tcp', ...target }));
      const socket = this as {
        emit?: (event: string, payload: unknown) => void;
        destroyed?: boolean;
      };
      // Report like a failed connect: Node emits `error` on the socket, and
      // every HTTP client above it rejects its own promise.
      queueMicrotask(() => socket.emit?.('error', error));
      return this;
    }
    return originalSocketConnect.apply(this, args);
  };

  guard.uninstall = () => {
    // Restore what was in place before installation, not an injected test seam.
    globalThis.fetch = previousFetch;
    socketPrototype.connect = originalSocketConnect;
  };

  return guard;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function resolveFetchUrl(input: FetchInput): EgressDecisionInput | undefined {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof (input as { url?: unknown })?.url === 'string'
          ? (input as { url: string }).url
          : undefined;
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return {
      protocol: parsed.protocol.replace(':', ''),
      hostname: parsed.hostname,
      ...(parsed.port ? { port: Number(parsed.port) } : {}),
    };
  } catch {
    return undefined;
  }
}

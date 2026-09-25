import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type {
  ListTuiSessionPageInput,
  TuiMessage,
  TuiMessagePage,
  TuiSession,
  TuiSessionPage,
} from '../runtime/port.js';
import type { TuiServerRuntime } from './runtime.js';

export const DEFAULT_TUI_SERVER_HOST = '127.0.0.1';
export const DEFAULT_TUI_SERVER_PORT = 8788;
const TUI_SERVER_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_SESSION_ID_SEGMENT_LENGTH = 256;

export interface TuiServerLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TuiServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface ServeTuiServerHttpOptions {
  readonly runtime: TuiServerRuntime;
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  readonly logger?: TuiServerLogger;
}

export type StartTuiServerHttpOptions = Omit<ServeTuiServerHttpOptions, 'signal'>;

/**
 * Start the read-only session HTTP server and resolve once it is listening.
 * The returned handle exposes the bound address (relevant with port 0) and
 * shuts the server down on close().
 */
export async function startTuiServerHttp(
  options: StartTuiServerHttpOptions,
): Promise<TuiServerHandle> {
  const logger = options.logger ?? console;
  const server = createServer((request, response) => {
    void handleTuiServerRequest(options.runtime, options.version, request, response).catch(
      (error) => {
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: toErrorMessage(error) });
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  // Post-listen socket failures must not crash the process; the command keeps
  // serving until its shutdown signal aborts.
  server.on('error', (error) => logger.warn(`Session server socket error: ${toErrorMessage(error)}`));
  const address = server.address();
  const host = typeof address === 'object' && address ? address.address : options.host;
  const port = typeof address === 'object' && address ? address.port : options.port;
  if (!TUI_SERVER_LOOPBACK_HOSTS.has(options.host)) {
    logger.warn(
      `Session server is bound to ${options.host}; every client that can reach this address can read your Sessions.`,
    );
  }
  logger.info(`Kinetick Code session server listening on http://${host}:${port}`);
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Start the session HTTP server and keep serving until the signal aborts.
 * Mirrors `serveTuiAcpStdio`: the returned promise settles only after the
 * server has stopped listening.
 */
export async function serveTuiServerHttp(options: ServeTuiServerHttpOptions): Promise<void> {
  const handle = await startTuiServerHttp(options);
  const signal = options.signal;
  if (!signal) return;
  if (signal.aborted) {
    await handle.close();
    return;
  }
  await new Promise<void>((resolve) => {
    const close = () => {
      signal.removeEventListener('abort', close);
      void handle.close().then(resolve, resolve);
    };
    signal.addEventListener('abort', close, { once: true });
  });
}

async function handleTuiServerRequest(
  runtime: TuiServerRuntime,
  version: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'only GET requests are supported' });
    return;
  }
  if (segments.length === 0) {
    sendJson(response, 200, {
      server: 'kinetick-code-session-server',
      version,
      health: '/health',
      sessions: '/sessions',
    });
    return;
  }
  if (segments[0] === 'health' && segments.length === 1) {
    sendJson(response, 200, { ok: true, version });
    return;
  }
  if (segments[0] !== 'sessions') {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  if (segments.length === 1) {
    await sendRuntimeJson(response, () =>
      runtime.listSessionPage(parseSessionPageInput(url.searchParams)),
    );
    return;
  }
  const sessionId = segments[1];
  if (sessionId.length > MAX_SESSION_ID_SEGMENT_LENGTH) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  if (segments.length === 2) {
    await sendRuntimeJson(response, () => runtime.getSession(sessionId));
    return;
  }
  if (segments.length === 3 && segments[2] === 'messages') {
    await sendRuntimeJson(response, async () => {
      // Preflight the session so unknown ids map to 404 consistently.
      await runtime.getSession(sessionId);
      return runtime.listMessagePage(sessionId, parseMessagePageInput(url.searchParams));
    });
    return;
  }
  sendJson(response, 404, { error: 'not found' });
}

type TuiServerPayload =
  | TuiSession
  | TuiSessionPage
  | TuiMessagePage
  | readonly TuiMessage[];

async function sendRuntimeJson(
  response: ServerResponse,
  load: () => Promise<TuiServerPayload>,
): Promise<void> {
  let payload: TuiServerPayload;
  try {
    payload = await load();
  } catch (error) {
    sendJson(response, toHttpStatus(error), { error: toErrorMessage(error) });
    return;
  }
  sendJson(response, 200, payload);
}

/**
 * Runtime failures carry a transport-neutral status (`AppError.status`) when
 * the application layer raises them, but the session-owner layer throws plain
 * `Error("Session not found: …")` — both are 404 at this boundary, the
 * session-access adapter's own lookup miss included. Query-validation errors
 * are 400, and anything else fails closed as 500.
 */
function toHttpStatus(error: unknown): number {
  if (error instanceof InvalidTuiServerQueryError) return 400;
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (
      typeof status === 'number' &&
      Number.isSafeInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return status;
    }
  }
  if (isSessionLookupMiss(error)) return 404;
  return 500;
}

function isSessionLookupMiss(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:did not return session|session not found)/iu.test(error.message)
  );
}

function parseSessionPageInput(query: URLSearchParams): ListTuiSessionPageInput {
  const input: ListTuiSessionPageInput = {};
  const limit = parseLimitQuery(query.get('limit'));
  if (limit !== undefined) input.limit = limit;
  const cursor = query.get('cursor');
  if (cursor) input.cursor = cursor;
  const agentName = query.get('agent');
  if (agentName) input.agentName = agentName;
  const allAgents = parseBooleanQuery(query, 'allAgents');
  if (allAgents !== undefined) input.allAgents = allAgents;
  const includeArchived = parseBooleanQuery(query, 'includeArchived');
  if (includeArchived !== undefined) input.includeArchived = includeArchived;
  const onlyArchived = parseBooleanQuery(query, 'onlyArchived');
  if (onlyArchived !== undefined) input.onlyArchived = onlyArchived;
  const includeHidden = parseBooleanQuery(query, 'includeHidden');
  if (includeHidden !== undefined) input.includeHidden = includeHidden;
  return input;
}

function parseMessagePageInput(query: URLSearchParams): { limit?: number; before?: string } {
  const input: { limit?: number; before?: string } = {};
  const limit = parseLimitQuery(query.get('limit'));
  if (limit !== undefined) input.limit = limit;
  const before = query.get('before');
  if (before) input.before = before;
  return input;
}

function parseLimitQuery(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new InvalidTuiServerQueryError(`invalid limit: ${value}`);
  }
  return limit;
}

function parseBooleanQuery(query: URLSearchParams, key: string): boolean | undefined {
  const value = query.get(key);
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InvalidTuiServerQueryError(`invalid ${key}: ${value}`);
}

class InvalidTuiServerQueryError extends Error {}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

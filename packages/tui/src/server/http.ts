import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { assertSessionServerToken, authorizationMatchesSessionToken } from './token.js';
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
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

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
  /** Bearer token required on every request, including `/` and `/health`. */
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly logger?: TuiServerLogger;
}

export type StartTuiServerHttpOptions = Omit<ServeTuiServerHttpOptions, 'signal'>;

/**
 * Start the session HTTP server and resolve once it is listening.
 * The returned handle exposes the bound address (relevant with port 0) and
 * shuts the server down on close().
 */
export async function startTuiServerHttp(
  options: StartTuiServerHttpOptions,
): Promise<TuiServerHandle> {
  assertSessionServerToken(options.token);
  const logger = options.logger ?? console;
  const server = createServer((request, response) => {
    void handleTuiServerRequest(
      options.runtime,
      options.version,
      options.token,
      request,
      response,
    ).catch(
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
  server.on('error', (error) =>
    logger.warn(`Session server socket error: ${toErrorMessage(error)}`),
  );
  const address = server.address();
  const host = typeof address === 'object' && address ? address.address : options.host;
  const port = typeof address === 'object' && address ? address.port : options.port;
  if (!TUI_SERVER_LOOPBACK_HOSTS.has(options.host)) {
    logger.warn(
      `Session server is bound to ${options.host}. Requests without the bearer token are refused. Anyone who obtains the token can read your Sessions and run turns.`,
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
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!authorizationMatchesSessionToken(request.headers.authorization, token)) {
    sendUnauthorized(response);
    request.resume();
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const method = request.method ?? 'GET';

  if (segments.length === 0) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    sendJson(response, 200, {
      server: 'kinetick-code-session-server',
      version,
      health: '/health',
      sessions: '/sessions',
      events: '/events (SSE)',
      prompt: 'POST /sessions/:id/prompt (SSE turn stream)',
    });
    return;
  }
  if (segments[0] === 'health' && segments.length === 1) {
    sendJson(response, 200, { ok: true, version });
    return;
  }

  // Runtime event stream (SSE): questionnaire/permission asks, session catalog
  // changes, queue updates. One `watchEvents` subscription per connection.
  if (segments[0] === 'events' && segments.length === 1) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    if (!runtime.watchEvents) {
      sendJson(response, 404, { error: 'event stream is not supported by this runtime' });
      return;
    }
    await handleEventsStream(runtime, request, response);
    return;
  }

  // Cross-session pending permission probes (permissions are not keyed by session).
  if (segments[0] === 'permissions' && segments.length === 4 && segments[3] === 'reply') {
    if (method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    if (!runtime.replyPermission) {
      sendJson(response, 404, { error: 'permissions are not supported by this runtime' });
      return;
    }
    const agentName = decodeURIComponent(segments[1]!);
    const requestId = decodeURIComponent(segments[2]!);
    await handleAction(response, async () => {
      const body = (await readJsonBody(request)) as { decision?: unknown };
      const decision = body.decision;
      if (decision !== 'allowOnce' && decision !== 'allowAlways' && decision !== 'deny') {
        throw new InvalidTuiServerBodyError('decision must be allowOnce | allowAlways | deny');
      }
      const ok = await runtime.replyPermission!(agentName, requestId, decision);
      return { ok };
    });
    return;
  }

  // Knowledge proposals (idle Skill/Memory drafts awaiting human review).
  if (segments[0] === 'skills' && segments[1] === 'proposals') {
    await handleSkillProposals(runtime, method, segments, url, request, response);
    return;
  }
  if (segments[0] === 'skills' && segments.length === 1) {
    await handleTopLevelList(runtime, method, url, response, 'listSkills');
    return;
  }

  sendJson(response, 404, { error: 'PARTIAL_UPLOAD_CONTINUE' });
}

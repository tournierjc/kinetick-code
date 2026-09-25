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
  server.on('error', (error) =>
    logger.warn(`Session server socket error: ${toErrorMessage(error)}`),
  );
  const address = server.address();
  const host = typeof address === 'object' && address ? address.address : options.host;
  const port = typeof address === 'object' && address ? address.port : options.port;
  if (!TUI_SERVER_LOOPBACK_HOSTS.has(options.host)) {
    logger.warn(
      `Session server is bound to ${options.host}; every client that can reach this address can read your Sessions and run turns on them.`,
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
  if (segments[0] === 'permissions' && segments.length === 1) {
    if (method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    if (!runtime.listPendingPermissions) {
      sendJson(response, 404, { error: 'permissions are not supported by this runtime' });
      return;
    }
    await sendRuntimeJson(response, () => runtime.listPendingPermissions!());
    return;
  }
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

  if (segments[0] === 'skills' && segments.length === 1) {
    await handleTopLevelList(runtime, method, url, response, 'listSkills');
    return;
  }
  if (segments[0] === 'mcp' && segments.length === 1) {
    await handleTopLevelList(runtime, method, url, response, 'listMcpServers');
    return;
  }
  if (segments[0] === 'status' && segments.length === 1) {
    await handleStatus(runtime, method, response);
    return;
  }

  if (segments[0] !== 'sessions') {
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  if (segments.length === 1) {
    if (method === 'GET') {
      await sendRuntimeJson(response, () =>
        runtime.listSessionPage(parseSessionPageInput(url.searchParams)),
      );
      return;
    }
    if (method === 'POST' && runtime.createSession) {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        const workspaceDir = typeof body.workspaceDir === 'string' ? body.workspaceDir : undefined;
        if (!workspaceDir) throw new InvalidTuiServerBodyError('workspaceDir is required');
        return runtime.createSession!({
          workspaceDir,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.parentSessionId === 'string'
            ? { parentSessionId: body.parentSessionId }
            : {}),
          ...(body.visibility === 'hidden' || body.visibility === 'visible'
            ? { visibility: body.visibility }
            : {}),
          ...(typeof body.purpose === 'string' ? { purpose: body.purpose } : {}),
        });
      });
      return;
    }
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  const sessionId = decodeURIComponent(segments[1]!);
  if (sessionId.length > MAX_SESSION_ID_SEGMENT_LENGTH) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  // /sessions/:id
  if (segments.length === 2) {
    if (method === 'GET' || method === 'HEAD') {
      await sendRuntimeJson(response, () => runtime.getSession(sessionId));
      return;
    }
    if (method === 'PATCH' && runtime.renameSession) {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request)) as { title?: unknown };
        if (typeof body.title !== 'string' || !body.title.trim()) {
          throw new InvalidTuiServerBodyError('title is required');
        }
        return runtime.renameSession!(sessionId, body.title);
      });
      return;
    }
    if (method === 'DELETE') {
      if (runtime.deleteSession) {
        await handleAction(response, async () => {
          await runtime.deleteSession!(sessionId);
          return { ok: true };
        });
        return;
      }
      if (runtime.archiveSession) {
        // The Runtime contract maps DELETE to a soft archive when no hard
        // delete is exposed, mirroring the TUI's delete-then-archive fallback.
        await handleAction(response, async () => {
          await runtime.archiveSession!(sessionId, true);
          return { ok: true, archived: true };
        });
        return;
      }
      sendJson(response, 405, { error: 'delete/archive is not supported by this runtime' });
      return;
    }
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  const sub = segments[2]!;

  // /sessions/:id/messages
  if (sub === 'messages' && segments.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    await sendRuntimeJson(response, async () => {
      // Preflight the session so unknown ids map to 404 consistently.
      await runtime.getSession(sessionId);
      return runtime.listMessagePage(sessionId, parseMessagePageInput(url.searchParams));
    });
    return;
  }

  // /sessions/:id/prompt — start a turn; TuiStreamEvents stream back as SSE.
  if (sub === 'prompt' && segments.length === 3 && method === 'POST') {
    if (!runtime.sendMessage) {
      sendJson(response, 404, { error: 'prompting is not supported by this runtime' });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: toErrorMessage(error) });
      return;
    }
    const content = (body as { content?: unknown }).content;
    if (typeof content !== 'string' || !content.trim()) {
      sendJson(response, 400, { error: 'content is required' });
      return;
    }
    const model = (body as { model?: unknown }).model;
    await streamGenerator(
      response,
      () =>
        runtime.sendMessage!({
          id: sessionId,
          content,
          ...(model && typeof model === 'object' ? { model } : {}),
        } as never),
      request,
    );
    return;
  }

  // /sessions/:id/abort
  if (sub === 'abort' && segments.length === 3 && method === 'POST') {
    if (!runtime.abortSession) {
      sendJson(response, 404, { error: 'abort is not supported by this runtime' });
      return;
    }
    await handleAction(response, async () => {
      const body = (await readJsonBody(request).catch(() => ({}))) as {
        turnId?: unknown;
        reason?: unknown;
      };
      const ok = await runtime.abortSession!({
        id: sessionId,
        ...(typeof body.turnId === 'string' ? { turnId: body.turnId } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      } as never);
      return { ok };
    });
    return;
  }

  // /sessions/:id/steer — steer the running turn with a message.
  if (sub === 'steer' && segments.length === 3 && method === 'POST') {
    if (!runtime.steer) {
      sendJson(response, 404, { error: 'steering is not supported by this runtime' });
      return;
    }
    await handleAction(response, async () => {
      const body = (await readJsonBody(request)) as { content?: unknown };
      if (typeof body.content !== 'string' || !body.content.trim()) {
        throw new InvalidTuiServerBodyError('content is required');
      }
      return runtime.steer!({
        sessionId,
        message: { text: body.content },
        producerId: 'session-server',
        idempotencyKey: `server-steer-${sessionId}-${Date.now()}`,
        source: 'session-server',
      } as never);
    });
    return;
  }

  // /sessions/:id/active-run
  if (sub === 'active-run' && segments.length === 3 && method === 'GET') {
    if (!runtime.getActiveRun) {
      sendJson(response, 404, { error: 'active-run is not supported by this runtime' });
      return;
    }
    await sendRuntimeJson(response, async () => {
      await runtime.getSession(sessionId);
      return runtime.getActiveRun!(sessionId);
    });
    return;
  }

  // /sessions/:id/delegation and /sessions/:id/delegation/stop
  if (sub === 'delegation' && segments.length >= 3) {
    if (segments.length === 3 && method === 'GET' && runtime.getDelegationSnapshot) {
      await sendRuntimeJson(response, async () => {
        await runtime.getSession(sessionId);
        return runtime.getDelegationSnapshot!(sessionId);
      });
      return;
    }
    if (
      segments.length === 4 &&
      segments[3] === 'stop' &&
      method === 'POST' &&
      runtime.stopDelegation
    ) {
      await handleAction(response, async () => {
        await runtime.getSession(sessionId);
        return runtime.stopDelegation!(sessionId);
      });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  // /sessions/:id/background-tasks
  if (sub === 'background-tasks' && segments.length === 3 && method === 'GET') {
    if (!runtime.listBackgroundTasks) {
      sendJson(response, 404, { error: 'background tasks are not supported by this runtime' });
      return;
    }
    await sendRuntimeJson(response, async () => {
      await runtime.getSession(sessionId);
      return runtime.listBackgroundTasks!(sessionId);
    });
    return;
  }

  // /sessions/:id/queue[/continue|/enqueue|/steer/:itemId|/delete/:itemId]
  if (sub === 'queue' && segments.length >= 3) {
    if (segments.length === 3 && method === 'GET' && runtime.getQueueSnapshot) {
      await sendRuntimeJson(response, async () => {
        await runtime.getSession(sessionId);
        return runtime.getQueueSnapshot!(sessionId);
      });
      return;
    }
    const action = segments[3];
    if (
      method === 'POST' &&
      action === 'continue' &&
      segments.length === 4 &&
      runtime.continueQueue
    ) {
      await handleAction(response, async () => {
        await runtime.continueQueue!(sessionId);
        return { ok: true };
      });
      return;
    }
    if (
      method === 'POST' &&
      action === 'enqueue' &&
      segments.length === 4 &&
      runtime.enqueueMessage
    ) {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request)) as { content?: unknown };
        if (typeof body.content !== 'string' || !body.content.trim()) {
          throw new InvalidTuiServerBodyError('content is required');
        }
        return runtime.enqueueMessage!(sessionId, body.content);
      });
      return;
    }
    if (
      method === 'POST' &&
      action === 'steer' &&
      segments.length === 5 &&
      runtime.steerQueuedMessage
    ) {
      await handleAction(response, async () =>
        runtime.steerQueuedMessage!(sessionId, decodeURIComponent(segments[4]!)),
      );
      return;
    }
    if (
      method === 'POST' &&
      action === 'delete' &&
      segments.length === 5 &&
      runtime.deleteQueuedMessage
    ) {
      await handleAction(response, async () => {
        const item = await runtime.deleteQueuedMessage!(
          sessionId,
          decodeURIComponent(segments[4]!),
        );
        return { ok: item !== undefined };
      });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  // /sessions/:id/interactions — what the phone should notify about for this session.
  if (sub === 'interactions' && segments.length === 3 && method === 'GET') {
    await sendRuntimeJson(response, async () => {
      const session = await runtime.getSession(sessionId);
      const agentName = session.agentName ?? '';
      const payload: Record<string, unknown> = { sessionId };
      if (agentName && runtime.getPendingQuestionnaire) {
        payload.questionnaire = await runtime.getPendingQuestionnaire(agentName, sessionId);
      }
      if (agentName && runtime.getLatestPlanReview) {
        payload.planReview = await runtime.getLatestPlanReview(agentName, sessionId);
      }
      if (runtime.listPendingPermissions) {
        const pending = await runtime.listPendingPermissions();
        payload.permissions = pending.filter(
          (permission) =>
            permission.sessionId === sessionId ||
            (agentName !== '' && permission.agentName === agentName),
        );
      }
      if (runtime.getActiveRun) {
        payload.activeRun = await runtime.getActiveRun(sessionId).catch(() => undefined);
      }
      return payload;
    });
    return;
  }

  // /sessions/:id/questionnaires/:requestId/reply|dismiss
  if (sub === 'questionnaires' && segments.length === 5 && segments[4] === 'reply') {
    if (method !== 'POST' || !runtime.replyQuestionnaire) {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    const requestId = decodeURIComponent(segments[3]!);
    await handleAction(response, async () => {
      const session = await runtime.getSession(sessionId);
      const body = (await readJsonBody(request)) as { answers?: unknown };
      if (!Array.isArray(body.answers)) {
        throw new InvalidTuiServerBodyError('answers must be an array');
      }
      const ok = await runtime.replyQuestionnaire!(
        session.agentName ?? '',
        requestId,
        body.answers as never,
      );
      return { ok };
    });
    return;
  }
  if (sub === 'questionnaires' && segments.length === 5 && segments[4] === 'dismiss') {
    if (method !== 'POST' || !runtime.dismissQuestionnaire) {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    const requestId = decodeURIComponent(segments[3]!);
    await handleAction(response, async () => {
      const session = await runtime.getSession(sessionId);
      const ok = await runtime.dismissQuestionnaire!(session.agentName ?? '', requestId);
      return { ok };
    });
    return;
  }

  // /sessions/:id/goal
  if (sub === 'goal' && segments.length === 3 && runtime.getGoal) {
    if (method === 'GET') {
      await sendRuntimeJson(response, async () => {
        await runtime.getSession(sessionId);
        return (await runtime.getGoal!(sessionId)) ?? null;
      });
      return;
    }
    if (method === 'POST' && runtime.createGoal) {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request)) as {
          objective?: unknown;
          tokenBudget?: unknown;
        };
        if (typeof body.objective !== 'string' || !body.objective.trim()) {
          throw new InvalidTuiServerBodyError('objective is required');
        }
        return runtime.createGoal!({
          sessionId,
          objective: body.objective,
          ...(typeof body.tokenBudget === 'number' ? { tokenBudget: body.tokenBudget } : {}),
        });
      });
      return;
    }
    if (method === 'PATCH' && runtime.patchGoal) {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        return runtime.patchGoal!(sessionId, body as never);
      });
      return;
    }
    if (method === 'DELETE' && runtime.clearGoal) {
      await handleAction(response, async () => ({ cleared: await runtime.clearGoal!(sessionId) }));
      return;
    }
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  // /sessions/:id/usage
  if (sub === 'usage' && segments.length === 3 && method === 'GET' && runtime.getSessionUsage) {
    await sendRuntimeJson(response, async () => {
      await runtime.getSession(sessionId);
      return runtime.getSessionUsage!(sessionId);
    });
    return;
  }

  // /sessions/:id/context
  if (
    sub === 'context' &&
    segments.length === 3 &&
    method === 'GET' &&
    runtime.getContextSnapshot
  ) {
    await sendRuntimeJson(response, async () => {
      await runtime.getSession(sessionId);
      return runtime.getContextSnapshot!(sessionId);
    });
    return;
  }

  // /sessions/:id/fork
  if (sub === 'fork' && segments.length === 3 && runtime.forkSession) {
    if (method === 'GET' && runtime.getSessionForkOptions) {
      const assistantMessageId = url.searchParams.get('assistantMessageId') ?? undefined;
      await sendRuntimeJson(response, async () => {
        await runtime.getSession(sessionId);
        return runtime.getSessionForkOptions!(sessionId, assistantMessageId);
      });
      return;
    }
    if (method === 'POST') {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request).catch(() => ({}))) as Record<string, unknown>;
        return runtime.forkSession!({
          sessionId,
          clientRequestId:
            typeof body.clientRequestId === 'string'
              ? body.clientRequestId
              : `server-${Date.now()}`,
          useSuggestedTitle: body.useSuggestedTitle !== false,
          createIsolatedWorktree: body.createIsolatedWorktree === true,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.assistantMessageId === 'string'
            ? { assistantMessageId: body.assistantMessageId }
            : {}),
        });
      });
      return;
    }
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  // /sessions/:id/archive { archived }
  if (sub === 'archive' && segments.length === 3 && method === 'POST' && runtime.archiveSession) {
    await handleAction(response, async () => {
      const body = (await readJsonBody(request)) as { archived?: unknown };
      if (typeof body.archived !== 'boolean') {
        throw new InvalidTuiServerBodyError('archived must be a boolean');
      }
      await runtime.archiveSession!(sessionId, body.archived);
      return { ok: true };
    });
    return;
  }

  // /sessions/:id/pin { pinned }
  if (sub === 'pin' && segments.length === 3 && method === 'POST' && runtime.pinSession) {
    await handleAction(response, async () => {
      const body = (await readJsonBody(request)) as { pinned?: unknown };
      if (typeof body.pinned !== 'boolean') {
        throw new InvalidTuiServerBodyError('pinned must be a boolean');
      }
      await runtime.pinSession!({ sessionId, pinned: body.pinned });
      return { ok: true };
    });
    return;
  }

  // /sessions/:id/rewind + /sessions/:id/rewind-preview/:userMessageId
  if (sub === 'rewind' && segments.length === 3 && method === 'POST' && runtime.rewindSession) {
    await handleAction(response, async () => {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      if (typeof body.userMessageId !== 'string') {
        throw new InvalidTuiServerBodyError('userMessageId is required');
      }
      return runtime.rewindSession!({
        sessionId,
        userMessageId: body.userMessageId,
        clientRequestId:
          typeof body.clientRequestId === 'string' ? body.clientRequestId : `server-${Date.now()}`,
        rewindTurnDiff: body.rewindTurnDiff === true,
      });
    });
    return;
  }
  if (
    sub === 'rewind-preview' &&
    segments.length === 4 &&
    method === 'GET' &&
    runtime.getSessionRewindPreview
  ) {
    await sendRuntimeJson(response, () =>
      runtime.getSessionRewindPreview!({
        sessionId,
        userMessageId: decodeURIComponent(segments[3]!),
      }),
    );
    return;
  }

  // /sessions/:id/model — GET lists models, POST selects one for the session.
  if (sub === 'model' && segments.length === 3 && runtime.listModels) {
    if (method === 'GET') {
      await sendRuntimeJson(response, () => runtime.listModels!(sessionId));
      return;
    }
    if (method === 'POST' && runtime.selectSessionModel) {
      await handleAction(response, async () => {
        const body = (await readJsonBody(request)) as { model?: unknown };
        const model = body.model as
          { providerId?: unknown; modelId?: unknown; variant?: unknown } | undefined;
        if (!model || typeof model.providerId !== 'string' || typeof model.modelId !== 'string') {
          throw new InvalidTuiServerBodyError('model.providerId and model.modelId are required');
        }
        const ok = await runtime.selectSessionModel!(model as never, sessionId);
        return { ok };
      });
      return;
    }
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  sendJson(response, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// Top-level resources (skills, MCP, status)
// ---------------------------------------------------------------------------

async function handleTopLevelList(
  runtime: TuiServerRuntime,
  method: string,
  url: URL,
  response: ServerResponse,
  capability: 'listSkills' | 'listMcpServers',
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }
  const list = runtime[capability];
  if (!list) {
    sendJson(response, 404, { error: `${capability} is not supported by this runtime` });
    return;
  }
  const keyword = url.searchParams.get('keyword') ?? undefined;
  if (capability === 'listSkills') {
    const agent = url.searchParams.get('agent') ?? undefined;
    const workspaceDir = url.searchParams.get('workspaceDir') ?? undefined;
    await sendRuntimeJson(response, () => runtime.listSkills!(agent, keyword, workspaceDir));
    return;
  }
  const sessionId = url.searchParams.get('sessionId') ?? undefined;
  await sendRuntimeJson(response, () => runtime.listMcpServers!(keyword, sessionId));
}

async function handleStatus(
  runtime: TuiServerRuntime,
  method: string,
  response: ServerResponse,
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }
  const payload: Record<string, unknown> = {};
  if (runtime.getRuntimeDiagnostics) {
    try {
      payload.diagnostics = await runtime.getRuntimeDiagnostics();
    } catch (error) {
      payload.diagnosticsError = toErrorMessage(error);
    }
  }
  if (runtime.getAccountStatus) {
    try {
      payload.account = await runtime.getAccountStatus();
    } catch (error) {
      payload.accountError = toErrorMessage(error);
    }
  }
  if (runtime.getPermissionMode) {
    payload.permissionMode = await runtime.getPermissionMode().catch(() => undefined);
  }
  if (runtime.listModels) {
    payload.models = await runtime.listModels().catch(() => undefined);
  }
  sendJson(response, 200, payload);
}

// ---------------------------------------------------------------------------
// Streams (SSE)
// ---------------------------------------------------------------------------

async function handleEventsStream(
  runtime: TuiServerRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  openSse(response);
  const abort = () => controller.abort();
  request.on('close', abort);
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(': ping\n\n');
  }, 15_000);
  try {
    for await (const event of runtime.watchEvents!(controller.signal)) {
      if (response.writableEnded) break;
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } catch {
    // Client disconnects and runtime shutdown end the generator; nothing to report.
  } finally {
    clearInterval(keepAlive);
    controller.abort();
    if (!response.writableEnded) response.end();
  }
}

async function streamGenerator(
  response: ServerResponse,
  open: () => AsyncGenerator<unknown>,
  request: IncomingMessage,
): Promise<void> {
  openSse(response);
  let iterator: AsyncGenerator<unknown>;
  try {
    iterator = open();
  } catch (error) {
    sendJson(response, 500, { error: toErrorMessage(error) });
    return;
  }
  const abort = () => {
    void iterator.return?.(undefined).catch(() => undefined);
  };
  request.on('close', abort);
  try {
    for await (const event of iterator) {
      if (response.writableEnded) break;
      const type =
        typeof event === 'object' && event && 'type' in event
          ? String((event as { type: unknown }).type)
          : 'event';
      response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (!response.writableEnded) response.write('event: end\ndata: {}\n\n');
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: toErrorMessage(error) });
    else if (!response.writableEnded) {
      response.write(
        `event: error\ndata: ${JSON.stringify({ message: toErrorMessage(error) })}\n\n`,
      );
    }
  } finally {
    request.off('close', abort);
    await iterator.return?.(undefined).catch(() => undefined);
    if (!response.writableEnded) response.end();
  }
}

function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(': open\n\n');
}

// ---------------------------------------------------------------------------
// Bodies, JSON envelopes, errors
// ---------------------------------------------------------------------------

async function handleAction(
  response: ServerResponse,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    const payload = await action();
    sendJson(response, 200, payload ?? { ok: true });
  } catch (error) {
    if (error instanceof InvalidTuiServerBodyError) {
      sendJson(response, 400, { error: toErrorMessage(error) });
      return;
    }
    sendJson(response, toHttpStatus(error), { error: toErrorMessage(error) });
  }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new InvalidTuiServerBodyError('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new InvalidTuiServerBodyError('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

/** Any JSON-serialisable Runtime projection; interfaces lack index signatures, so this stays wide. */
type TuiServerPayload = object | readonly unknown[] | string | number | boolean | null;

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
  if (error instanceof InvalidTuiServerBodyError) return 400;
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
    error instanceof Error && /(?:did not return session|session not found)/iu.test(error.message)
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
class InvalidTuiServerBodyError extends Error {}

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

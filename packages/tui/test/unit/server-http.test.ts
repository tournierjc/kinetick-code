import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TUI_SERVER_PORT,
  startTuiServerHttp,
  type TuiServerHandle,
} from '../../src/server/http.js';
import type { TuiServerRuntime } from '../../src/server/runtime.js';
import type {
  ListTuiSessionPageInput,
  TuiMessage,
  TuiMessagePage,
  TuiSession,
  TuiSessionPage,
} from '../../src/runtime/port.js';

interface RecordedRuntime {
  readonly runtime: TuiServerRuntime;
  readonly sessionPageInputs: ListTuiSessionPageInput[];
  readonly messageInputs: { sessionId: string; input?: { limit?: number; before?: string } }[];
}

/** Mirrors the Runtime's transport-neutral failure: `AppError(status, key, message)`. */
function sessionNotFound(sessionId: string): Error {
  return Object.assign(new Error(`Session not found: ${sessionId}`), {
    status: 404,
    key: 'local_session_not_found',
  });
}

function createFakeRuntime(): RecordedRuntime {
  const sessions: TuiSession[] = [
    { sessionId: 'session-1', title: 'Fix the parser', workspaceDir: '/workspace' },
    { sessionId: 'session-2', title: 'Review the fork', workspaceDir: '/workspace' },
  ];
  const recorded: RecordedRuntime = {
    sessionPageInputs: [],
    messageInputs: [],
    runtime: {
      async listSessionPage(inputOrAgentName?: ListTuiSessionPageInput | string) {
        const input =
          typeof inputOrAgentName === 'string' ? {} : (inputOrAgentName ?? {});
        recorded.sessionPageInputs.push(input);
        const page: TuiSessionPage = { sessions, hasMore: false };
        return page;
      },
      async getSession(sessionId: string): Promise<TuiSession> {
        const session = sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!session) throw sessionNotFound(sessionId);
        return session;
      },
      async listMessagePage(sessionId: string, input): Promise<TuiMessagePage> {
        recorded.messageInputs.push({ sessionId, input });
        const first: TuiMessage = { id: 'm1', role: 'user', content: 'hello' };
        const second: TuiMessage = { id: 'm2', role: 'assistant', content: 'hi there' };
        return { messages: [first, second], hasMore: false };
      },
    },
  };
  return recorded;
}

describe('session server HTTP contract', () => {
  let handle: TuiServerHandle | undefined;
  let recorded: RecordedRuntime | undefined;

  beforeEach(() => {
    recorded = createFakeRuntime();
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function start(
    options: { host?: string; port?: number } = {},
  ): Promise<TuiServerHandle> {
    handle = await startTuiServerHttp({
      runtime: recorded!.runtime,
      version: 'test-version',
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      logger: { info: () => undefined, warn: () => undefined },
    });
    return handle;
  }

  async function get(path: string, init?: RequestInit): Promise<Response> {
    const server = handle!;
    return fetch(`http://127.0.0.1:${server.port}${path}`, init);
  }

  it('reports a positive bound port and the default port constant', async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(DEFAULT_TUI_SERVER_PORT).toBe(8788);
  });

  it('answers the index and health endpoints', async () => {
    await start();
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(await index.json()).toMatchObject({
      server: 'kinetick-code-session-server',
      version: 'test-version',
      sessions: '/sessions',
    });
    const health = await get('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 'test-version' });
    expect(health.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(health.headers.get('cache-control')).toBe('no-store');
  });

  it('serves the session list and forwards the query contract', async () => {
    await start();
    const response = await get('/sessions?limit=5&includeArchived=true&agent=worker');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as TuiSessionPage;
    expect(payload.sessions.map((session) => session.sessionId)).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(payload.hasMore).toBe(false);
    expect(recorded!.sessionPageInputs).toEqual([
      { limit: 5, includeArchived: true, agentName: 'worker' },
    ]);
  });

  it('rejects invalid session list query values', async () => {
    await start();
    const badLimit = await get('/sessions?limit=zero');
    expect(badLimit.status).toBe(400);
    expect(((await badLimit.json()) as { error: string }).error).toContain('invalid limit');
    const badFlag = await get('/sessions?allAgents=maybe');
    expect(badFlag.status).toBe(400);
    expect(((await badFlag.json()) as { error: string }).error).toContain('invalid allAgents');
  });

  it('serves a single session and maps unknown sessions to 404', async () => {
    await start();
    const found = await get('/sessions/session-1');
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ sessionId: 'session-1' });
    const missing = await get('/sessions/session-missing');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain(
      'Session not found: session-missing',
    );
  });

  it('honours a transport-neutral runtime status on failures', async () => {
    recorded!.runtime.getSession = async () => {
      throw Object.assign(new Error('This session already has a handoff proposal awaiting approval.'), {
        status: 409,
        key: 'HANDOFF_PREFLIGHT_DENIED',
      });
    };
    await start();
    const response = await get('/sessions/session-1');
    expect(response.status).toBe(409);
  });

  it('fails closed as 500 for a failure without a status', async () => {
    recorded!.runtime.getSession = async () => {
      throw new Error('database is locked');
    };
    await start();
    const response = await get('/sessions/session-1');
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain('database is locked');
  });

  it('maps the adapter lookup miss to 404 without a runtime status', async () => {
    recorded!.runtime.getSession = async (sessionId: string) => {
      throw new Error(`Runtime did not return session ${sessionId}.`);
    };
    await start();
    const response = await get('/sessions/session-1');
    expect(response.status).toBe(404);
  });

  it('maps the session-owner plain not-found error to 404', async () => {
    recorded!.runtime.getSession = async (sessionId: string) => {
      throw new Error(`Session not found: ${sessionId}`);
    };
    await start();
    const response = await get('/sessions/session-1');
    expect(response.status).toBe(404);
  });

  it('serves a session transcript after validating the session id', async () => {
    await start();
    const response = await get('/sessions/session-1/messages?limit=2&before=m1');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as TuiMessagePage;
    expect(payload.messages).toHaveLength(2);
    expect(recorded!.messageInputs).toEqual([
      { sessionId: 'session-1', input: { limit: 2, before: 'm1' } },
    ]);
    const missing = await get('/sessions/session-missing/messages');
    expect(missing.status).toBe(404);
    expect(recorded!.messageInputs).toHaveLength(1);
  });

  it('rejects unknown paths and unsupported methods', async () => {
    await start();
    expect((await get('/sessions/session-1/unknown')).status).toBe(404);
    expect((await get('/nope')).status).toBe(404);
    // The server is writable: POST /sessions creates a session, so an
    // unsupported verb on it is 405, and unknown sub-resources stay 404.
    const put = await get('/sessions', { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(((await put.json()) as { error: string }).error).toContain('method not allowed');
    const putSession = await get('/sessions/session-1', { method: 'PUT' });
    expect(putSession.status).toBe(405);
  });

  it('warns when binding a non-loopback host', async () => {
    const warnings: string[] = [];
    const server = await startTuiServerHttp({
      runtime: recorded!.runtime,
      version: 'test-version',
      host: '0.0.0.0',
      port: 0,
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
      },
    });
    handle = server;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('every client that can reach this address');
  });

  it('stops serving after close()', async () => {
    const server = await start();
    await get('/health');
    await server.close();
    await expect(get('/health')).rejects.toThrow();
  });

  // --- Write surface -------------------------------------------------------

  async function startWritable(): Promise<void> {
    const writable = createFakeRuntime();
    const calls: string[] = [];
    Object.assign(writable.runtime, {
      async createSession(input: { workspaceDir: string; title?: string }) {
        calls.push(`create:${input.workspaceDir}:${input.title ?? ''}`);
        return { sessionId: 'session-3', title: input.title, workspaceDir: input.workspaceDir };
      },
      async renameSession(sessionId: string, title: string) {
        calls.push(`rename:${sessionId}:${title}`);
        return { sessionId, title, workspaceDir: '/workspace' };
      },
      async deleteSession(sessionId: string) {
        calls.push(`delete:${sessionId}`);
      },
      async abortSession(req: { id: string }) {
        calls.push(`abort:${req.id}`);
        return true;
      },
      async replyPermission(agentName: string, requestId: string, decision: string) {
        calls.push(`permission:${agentName}:${requestId}:${decision}`);
        return true;
      },
      async listPendingPermissions() {
        return [{ requestId: 'perm-1', toolName: 'bash', sessionId: 'session-1' }];
      },
      async *sendMessage(req: { id: string; content: string }) {
        calls.push(`send:${req.id}:${req.content}`);
        yield { type: 'session-status', status: 'started', turnId: 'turn-1' };
        yield { type: 'delta', turnId: 'turn-1', content: 'hello' };
        yield { type: 'done', turnId: 'turn-1' };
      },
      async getDelegationSnapshot(rootSessionId: string) {
        return {
          schemaVersion: 1 as const,
          rootSessionId,
          members: [{ sessionId: 'child-1', parentSessionId: rootSessionId, status: 'running' as const }],
        };
      },
      async listSkills() {
        return { skills: [{ name: 'pdf', description: 'work with pdf files' }] };
      },
    });
    recorded = writable;
    (recorded as { runtime: Record<string, unknown> }).runtime = writable.runtime;
    handle = await startTuiServerHttp({
      runtime: writable.runtime,
      version: 'test-version',
      host: '127.0.0.1',
      port: 0,
      logger: { info: () => undefined, warn: () => undefined },
    });
    void calls;
  }

  it('creates, renames, and deletes sessions through the write verbs', async () => {
    await startWritable();
    const created = await get('/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceDir: '/workspace', title: 'New work' }),
    });
    expect(created.status).toBe(200);
    const renamed = await get('/sessions/session-1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(renamed.status).toBe(200);
    const deleted = await get('/sessions/session-2', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const badCreate = await get('/sessions', { method: 'POST', body: JSON.stringify({}) });
    expect(badCreate.status).toBe(400);
  });

  it('streams a prompt turn as SSE and aborts sessions', async () => {
    await startWritable();
    const response = await get('/sessions/session-1/prompt', {
      method: 'POST',
      body: JSON.stringify({ content: 'do the thing' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('event: session-status');
    expect(body).toContain('event: delta');
    expect(body).toContain('event: done');
    expect(body).toContain('event: end');

    const aborted = await get('/sessions/session-1/abort', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(aborted.status).toBe(200);
    expect(((await aborted.json()) as { ok: boolean }).ok).toBe(true);

    const missingContent = await get('/sessions/session-1/prompt', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(missingContent.status).toBe(400);
  });

  it('serves permissions, delegation, and skills resources', async () => {
    await startWritable();
    const pending = await get('/permissions');
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual([
      { requestId: 'perm-1', toolName: 'bash', sessionId: 'session-1' },
    ]);

    const reply = await get('/permissions/worker/perm-1/reply', {
      method: 'POST',
      body: JSON.stringify({ decision: 'allowOnce' }),
    });
    expect(reply.status).toBe(200);
    const badDecision = await get('/permissions/worker/perm-1/reply', {
      method: 'POST',
      body: JSON.stringify({ decision: 'yes' }),
    });
    expect(badDecision.status).toBe(400);

    const delegation = await get('/sessions/session-1/delegation');
    expect(delegation.status).toBe(200);
    const snapshot = (await delegation.json()) as { members: unknown[] };
    expect(snapshot.members).toHaveLength(1);

    const skills = await get('/skills?keyword=pdf');
    expect(skills.status).toBe(200);
    const list = (await skills.json()) as { skills: { name: string }[] };
    expect(list.skills[0]?.name).toBe('pdf');
  });

  it('reports unsupported capabilities as 404 for the minimal runtime', async () => {
    await start();
    // The minimal read-only fake runtime exposes none of the write surface.
    expect((await get('/sessions/session-1/prompt', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await get('/permissions')).status).toBe(404);
    expect((await get('/skills')).status).toBe(404);
    expect((await get('/sessions/session-1/delegation')).status).toBe(404);
    expect((await get('/events')).status).toBe(404);
  });
});

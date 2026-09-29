import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';
import type {
  LocalMcpRuntimeContext,
  LocalMcpServerConfig,
  ProjectMcpPreview,
} from './contracts.js';
import { configToTransportConfig } from './runtime/config.js';
import {
  readProjectMcpConfig,
  projectMcpDigest,
  isReservedProjectMcpName,
  type ProjectMcpDocument,
} from './project-config.js';
import { isProjectStdioTrusted } from './project-stdio-trust.js';

interface ProjectSnapshot {
  document: ProjectMcpDocument;
  servers: Record<string, LocalMcpServerConfig>;
  keys: Map<string, string>;
  statuses: Map<string, { status: 'available' | 'error'; error?: string }>;
  active: boolean;
  abort: AbortController;
}

const UNTRUSTED_STDIO_REASON =
  'Project stdio MCP is not trusted. Review .mcp.json and run `kcode mcp trust` in this workspace.';

/** Caller serializes resolve/clear with the MCP owner's mutation queue. */
export class ProjectMcpRuntime {
  private readonly snapshots = new Map<string, ProjectSnapshot>();
  private readonly bindings = new WeakMap<
    LocalMcpServerConfig,
    { snapshot: ProjectSnapshot; name: string }
  >();

  constructor(
    private readonly pool?: McpConnectionPool,
    private readonly dataDir: () => string = () => '',
  ) {}

  async resolve(context?: LocalMcpRuntimeContext): Promise<Record<string, LocalMcpServerConfig>> {
    if (!context?.workspaceRoot || !context.sessionId) return {};
    const document = await readProjectMcpConfig(context.workspaceRoot);
    const current = this.snapshots.get(context.sessionId);
    if (current?.document.root === document.root && current.document.digest === document.digest) {
      return current.servers;
    }
    await this.clearSnapshot(context.sessionId);
    const snapshot: ProjectSnapshot = {
      document,
      servers: Object.create(null),
      keys: new Map(),
      statuses: new Map(),
      active: true,
      abort: new AbortController(),
    };
    for (const entry of document.entries) {
      if (isReservedProjectMcpName(entry.name)) continue;
      const config = {
        ...entry.config,
        enabled: entry.config?.enabled !== false && !entry.error,
        builtin: false,
        configured: true,
      };
      const stdio = isProjectStdioConfig(config);
      const trusted =
        !stdio || (await isProjectStdioTrusted(this.dataDir(), document.root, document.digest));
      const effective = stdio && !trusted ? { ...config, enabled: false } : config;
      snapshot.servers[entry.name] = effective;
      if (stdio && !trusted) {
        snapshot.statuses.set(entry.name, { status: 'error', error: UNTRUSTED_STDIO_REASON });
      }
      snapshot.keys.set(
        entry.name,
        `project:${projectMcpDigest(JSON.stringify([context.sessionId, document.root, document.digest, entry.name]))}`,
      );
      this.bindings.set(config, { snapshot, name: entry.name });
    }
    this.snapshots.set(context.sessionId, snapshot);
    return snapshot.servers;
  }

  async inspect(context: LocalMcpRuntimeContext): Promise<ProjectMcpPreview> {
    await this.resolve(context);
    const snapshot = context.sessionId ? this.snapshots.get(context.sessionId) : undefined;
    if (!snapshot) throw new Error('Project MCP inspection requires a session and workspace.');
    return {
      path: snapshot.document.path,
      digest: snapshot.document.digest,
      ...(snapshot.document.error ? { error: snapshot.document.error } : {}),
      servers: snapshot.document.entries.map((entry) => {
        const config = entry.config;
        const status = projectStatus(snapshot, entry);
        return {
          name: entry.name,
          transport: config?.type ?? 'none',
          status: status.status,
          ...(status.error ? { error: status.error } : {}),
          // Values in args/env/headers/URL queries are never exposed by inspection.
          target: config?.command ?? remoteTarget(config?.url),
        };
      }),
    };
  }

  overrides(config: LocalMcpServerConfig): McpConnectionTokenOverrides | undefined {
    const binding = this.bindings.get(config);
    if (!binding) return undefined;
    const { snapshot, name } = binding;
    if (!snapshot.active || !config.enabled)
      throw new Error('Project MCP configuration is no longer active.');
    const transport = configToTransportConfig(config);
    if (!transport) throw new Error('Invalid project MCP transport.');
    return {
      connectionKey: snapshot.keys.get(name),
      serverOverride: {
        name,
        enabled: true,
        transport:
          transport.type === 'stdio'
            ? { ...transport, cwd: snapshot.document.root }
            : { ...transport, protectHeadersOnRedirect: true },
        workspaceRoot: snapshot.document.root,
        ...(config.timeout ? { timeout: config.timeout } : {}),
      },
    };
  }

  signal(config: LocalMcpServerConfig): AbortSignal | undefined {
    return this.bindings.get(config)?.snapshot.abort.signal;
  }

  record(config: LocalMcpServerConfig | undefined, error?: string): boolean {
    const binding = config ? this.bindings.get(config) : undefined;
    if (!binding) return false;
    if (binding.snapshot.active)
      binding.snapshot.statuses.set(
        binding.name,
        error ? { status: 'error', error } : { status: 'available' },
      );
    return true;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.clearSnapshot(sessionId);
  }

  private async clearSnapshot(sessionId: string): Promise<void> {
    const current = this.snapshots.get(sessionId);
    if (!current) return;
    current.active = false;
    current.abort.abort();
    this.snapshots.delete(sessionId);
    const pool = this.pool;
    if (!pool) return;
    await Promise.allSettled(
      [...current.keys].map(([name, connectionKey]) => pool.disconnect(name, { connectionKey })),
    );
  }
}

function remoteTarget(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function projectStatus(
  snapshot: ProjectSnapshot,
  entry: ProjectMcpDocument['entries'][number],
): { status: ProjectMcpPreview['servers'][number]['status']; error?: string } {
  if (entry.error) return { status: 'error', error: entry.error };
  const recorded = snapshot.statuses.get(entry.name);
  if (recorded?.error) return recorded;
  if (entry.config?.enabled === false) return { status: 'disabled' };
  return recorded ?? { status: 'configured' };
}

function isProjectStdioConfig(config: LocalMcpServerConfig): boolean {
  if (config.type === 'http' || config.type === 'sse' || config.type === 'streamable-http') {
    return false;
  }
  return config.type === 'stdio' || typeof config.command === 'string';
}

import { resolveCanonicalSubagentRole } from '@mavis/agent-tools/desktop/subagent-roles';

/**
 * The spawn-policy shape this module consumes. It is structurally identical
 * to `CanonicalAgentMavisConfig`'s policy fields; declaring it locally keeps
 * the V1 task runner host ports free of a storage-module import.
 */
export interface AgentMavisSpawnPolicy {
  readonly spawnMode?: AgentSpawnMode;
  readonly canSpawn?: readonly string[];
}

/**
 * Declarative spawn policy carried by a Custom Agent's canonical file
 * (`x-mavis.spawnMode` / `x-mavis.canSpawn`). It composes with — never
 * replaces — the runtime-owned builtin feature policy: a Builtin Agent
 * without an explicit policy keeps today's behavior exactly.
 */
export type AgentSpawnMode = 'subagent-only' | 'master-only' | 'both';

const SPAWN_MODES = new Set<AgentSpawnMode>(['subagent-only', 'master-only', 'both']);

/** Parses `x-mavis.spawnMode`; absent means 'both' (today's behavior). */
export function parseAgentSpawnMode(
  source: Record<string, unknown>,
  invalid: (field: string, message: string) => Error,
): AgentSpawnMode | undefined {
  const value = source['spawnMode'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SPAWN_MODES.has(value as AgentSpawnMode)) {
    throw invalid(
      'x-mavis.spawnMode',
      'spawnMode must be one of subagent-only, master-only, both.',
    );
  }
  return value as AgentSpawnMode;
}

/** Normalizes `x-mavis.canSpawn` to a trimmed, deduplicated, frozen list. */
export function normalizeCanSpawn(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) seen.add(normalized);
  }
  return Object.freeze([...seen]);
}

export interface AgentSpawnGateInput {
  /** Resolved stable name of the target Agent (canonical custom owner name). */
  readonly targetAgentName: string;
  readonly targetPolicy: AgentMavisSpawnPolicy;
  /** Resolved stable name of the requesting parent Agent; absent for user-initiated. */
  readonly parentAgentName?: string;
  /** True when the requesting session is a task child (spawned via `task`). */
  readonly parentIsTaskChild: boolean;
}

export type AgentSpawnGateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'AGENT_SPAWN_MODE_FORBIDDEN' | 'AGENT_SPAWN_NOT_PERMITTED';
      readonly reason: string;
    };

function targetMatchesEntries(
  entries: readonly string[],
  targetAgentName: string,
): boolean {
  const normalized = targetAgentName.trim().toLowerCase();
  if (entries.includes(normalized)) return true;
  // A canSpawn entry naming a canonical role selects the trusted builtin
  // target; custom rows must be named by their stable name.
  const role = resolveCanonicalSubagentRole(normalized);
  return role !== undefined && entries.includes(role) && normalized === role;
}

/**
 * Single enforcement point for the declarative agent-to-agent spawn graph.
 * Callers run this after name resolution, before creating the child Session.
 * An absent policy (`undefined`) allows everything, so every agent without
 * an explicit `x-mavis` block behaves exactly as before this feature.
 */
export function evaluateAgentSpawnGate(
  input: AgentSpawnGateInput,
): AgentSpawnGateDecision {
  const mode = input.targetPolicy.spawnMode ?? 'both';
  const parent = input.parentAgentName?.trim();

  if (input.parentAgentName !== undefined && input.parentIsTaskChild) {
    // A master-only Agent exists for user-initiated sessions only.
    if (mode === 'master-only') {
      return {
        allowed: false,
        code: 'AGENT_SPAWN_MODE_FORBIDDEN',
        reason: `Agent "${input.targetAgentName}" is master-only and cannot be spawned by a subagent.`,
      };
    }
    const canSpawn = input.targetPolicy.canSpawn;
    if (canSpawn !== undefined && parent && !targetMatchesEntries(canSpawn, parent)) {
      return {
        allowed: false,
        code: 'AGENT_SPAWN_NOT_PERMITTED',
        reason: `Agent "${input.targetAgentName}" only accepts spawns from: ${canSpawn.join(', ')}.`,
      };
    }
  }

  if (input.parentAgentName === undefined && mode === 'subagent-only') {
    // A subagent-only Agent is not a user-facing session target.
    return {
      allowed: false,
      code: 'AGENT_SPAWN_MODE_FORBIDDEN',
      reason: `Agent "${input.targetAgentName}" is subagent-only and cannot start a user session.`,
    };
  }

  return { allowed: true };
}

/** Convenience overload for callers holding only a full canonical config. */
export function evaluateAgentSpawnGateForConfig(
  input: Omit<AgentSpawnGateInput, 'targetPolicy'> & {
    readonly targetConfig: { readonly xMavis?: AgentMavisSpawnPolicy };
  },
): AgentSpawnGateDecision {
  return evaluateAgentSpawnGate({
    targetAgentName: input.targetAgentName,
    targetPolicy: input.targetConfig.xMavis ?? {},
    parentAgentName: input.parentAgentName,
    parentIsTaskChild: input.parentIsTaskChild,
  });
}

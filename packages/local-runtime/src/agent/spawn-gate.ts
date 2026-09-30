import type { AgentReferenceReadScope } from '@mavis/shared';
import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { resolveCanonicalSubagentRole } from '@mavis/agent-tools/desktop/subagent-roles';

/**
 * Declarative spawn-policy gate evaluated after name resolution and before
 * the child Session is created. It composes with the runtime-owned builtin
 * tool ceilings (canonical-tool-policy) and the delegation feature gate:
 * those decide *capability*, this decides *permission between named Agents*.
 *
 * The gate fails open on every resolution gap (no port, unresolvable parent,
 * unreadable policy, builtin target): an Agent that declares no policy must
 * behave exactly as before the feature.
 */
export interface AgentMavisSpawnPolicy {
  spawnMode?: 'subagent-only' | 'master-only' | 'both';
  canSpawn?: readonly string[];
}

export interface AgentSpawnPolicyReader {
  getAgentSpawnPolicy(agentName: string): Promise<AgentMavisSpawnPolicy>;
}

export interface LocalSpawnGateFacts {
  /** Stable name of the parent Agent, resolved from the parent Session. */
  parentAgentName?: string;
  /** True when the parent Session is itself a task child. */
  parentIsTaskChild: boolean;
}

export interface LocalSpawnGateDecision {
  allowed: boolean;
  reason?: string;
}

function normalizeEntries(entries: readonly string[]): readonly string[] {
  return entries.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

function targetMatchesEntries(entries: readonly string[], target: string): boolean {
  const normalized = target.trim().toLowerCase();
  if (entries.includes(normalized)) return true;
  // An entry naming a canonical role selects the trusted builtin target only.
  const role = resolveCanonicalSubagentRole(normalized);
  return role !== undefined && entries.includes(role) && normalized === role;
}

export function evaluateLocalAgentSpawnGate(input: {
  targetAgentName: string;
  targetPolicy: AgentMavisSpawnPolicy;
  parent: LocalSpawnGateFacts;
}): LocalSpawnGateDecision {
  const mode = input.targetPolicy.spawnMode ?? 'both';
  if (!input.parent.parentIsTaskChild) {
    // User-initiated spawn: master-only and both are unrestricted here;
    // subagent-only Agents stay user-facing at Session-create level.
    return { allowed: true };
  }
  if (mode === 'master-only') {
    return {
      allowed: false,
      reason: `Agent "${input.targetAgentName}" is master-only and cannot be spawned by a subagent.`,
    };
  }
  const canSpawn = input.targetPolicy.canSpawn;
  const parent = input.parent.parentAgentName?.trim() || undefined;
  // Fail closed: a canSpawn allowlist is an explicit restriction, so a parent
  // whose stable name cannot be resolved may not spawn the target.
  if (canSpawn !== undefined && !parent) {
    return {
      allowed: false,
      reason: `Agent "${input.targetAgentName}" restricts spawns to named Agents and the parent Agent identity is unavailable.`,
    };
  }
  if (canSpawn !== undefined && parent && !targetMatchesEntries(normalizeEntries(canSpawn), parent)) {
    return {
      allowed: false,
      reason: `Agent "${input.targetAgentName}" only accepts spawns from: ${canSpawn.join(', ')}.`,
    };
  }
  return { allowed: true };
}

/** Resolves the parent facts best-effort; a missing lookup leaves parentAgentName undefined. */
export async function resolveLocalSpawnGateFacts(
  host: Pick<LocalTaskRunnerHostWithSessionLookup, 'getSessionById'> & {
    agentResolver?: {
      resolveAgentReadScope(name: string): Promise<Pick<AgentReferenceReadScope, 'exactOwnerName'>>;
    };
  },
  parentSession: LocalSessionRecord,
): Promise<LocalSpawnGateFacts> {
  const parentIsTaskChild = parentSession.sessionKind === 'task';
  if (!parentIsTaskChild) return { parentIsTaskChild: false };
  let parentAgentName: string | undefined = parentSession.agentName?.trim() || undefined;
  // The session row carries the requested agent name; resolve it to the
  // stable owner so a canSpawn entry matches on canonical identity.
  if (parentAgentName && host.agentResolver?.resolveAgentReadScope) {
    try {
      const scope = await host.agentResolver.resolveAgentReadScope(parentAgentName);
      parentAgentName = scope.exactOwnerName?.trim() || parentAgentName;
    } catch {
      // Keep the raw name: matching is best-effort and fails open upstream.
    }
  }
  return { parentIsTaskChild: true, ...(parentAgentName ? { parentAgentName } : {}) };
}

import { describe, expect, it } from "vitest";

import {
  evaluateAgentSpawnGate,
  normalizeCanSpawn,
  parseAgentSpawnMode,
} from "../../../../src/service/agent/domain/spawn-policy.js";
import { AgentConfigError } from "../../../../src/service/agent/storage/canonical-agent-config.js";

const invalid = (field: string, message: string): Error =>
  new AgentConfigError("AGENT_CONFIG_INVALID", field, message);

describe("x-mavis spawn policy parsing", () => {
  it("treats an absent spawnMode as no policy", () => {
    expect(parseAgentSpawnMode({}, invalid)).toBeUndefined();
  });

  it("accepts the three documented modes", () => {
    for (const spawnMode of ["subagent-only", "master-only", "both"] as const) {
      expect(parseAgentSpawnMode({ spawnMode }, invalid)).toBe(spawnMode);
    }
  });

  it("rejects an unknown mode naming the accepted values", () => {
    expect(() => parseAgentSpawnMode({ spawnMode: "solo" }, invalid)).toThrow(
      /subagent-only, master-only, both/,
    );
  });

  it("normalizes canSpawn entries to trimmed, deduplicated, frozen names", () => {
    const canSpawn = normalizeCanSpawn([" Orchestrator ", "orchestrator", "analyst"]);
    expect(canSpawn).toEqual(["orchestrator", "analyst"]);
    expect(Object.isFrozen(canSpawn)).toBe(true);
  });
});

describe("canonical spawn gate (agent.md level)", () => {
  it("rejects a master-only spawn from a task-child parent", () => {
    const decision = evaluateAgentSpawnGate({
      targetAgentName: "planner",
      targetPolicy: { spawnMode: "master-only" },
      parentAgentName: "orchestrator",
      parentIsTaskChild: true,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("AGENT_SPAWN_MODE_FORBIDDEN");
  });

  it("rejects a user session on a subagent-only agent", () => {
    const decision = evaluateAgentSpawnGate({
      targetAgentName: "deep-lab",
      targetPolicy: { spawnMode: "subagent-only" },
      parentIsTaskChild: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("AGENT_SPAWN_MODE_FORBIDDEN");
  });

  it("allows an allowlisted parent and denies the rest", () => {
    const base = {
      targetAgentName: "builder",
      targetPolicy: { canSpawn: ["orchestrator"] },
      parentIsTaskChild: true as const,
    };
    expect(evaluateAgentSpawnGate({ ...base, parentAgentName: "orchestrator" })).toEqual({
      allowed: true,
    });
    const denied = evaluateAgentSpawnGate({ ...base, parentAgentName: "raider" });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.code).toBe("AGENT_SPAWN_NOT_PERMITTED");
  });
});

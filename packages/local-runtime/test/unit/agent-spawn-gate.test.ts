import { describe, expect, it } from "vitest";

import {
  evaluateLocalAgentSpawnGate,
  type LocalSpawnGateFacts,
} from "../../src/agent/spawn-gate.js";

const USER_SPAWN: LocalSpawnGateFacts = { parentIsTaskChild: false };
const TASK_CHILD_SPAWN: LocalSpawnGateFacts = {
  parentIsTaskChild: true,
  parentAgentName: "orchestrator",
};

describe("declarative agent spawn gate", () => {
  it("allows every spawn for an agent without a declared policy", () => {
    expect(
      evaluateLocalAgentSpawnGate({
        targetAgentName: "worker",
        targetPolicy: {},
        parent: TASK_CHILD_SPAWN,
      }),
    ).toEqual({ allowed: true });
  });

  it("denies a master-only target spawned by a task child", () => {
    const decision = evaluateLocalAgentSpawnGate({
      targetAgentName: "planner",
      targetPolicy: { spawnMode: "master-only" },
      parent: TASK_CHILD_SPAWN,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("master-only");
  });

  it("allows a master-only target spawned by a user session", () => {
    expect(
      evaluateLocalAgentSpawnGate({
        targetAgentName: "planner",
        targetPolicy: { spawnMode: "master-only" },
        parent: USER_SPAWN,
      }),
    ).toEqual({ allowed: true });
  });

  it("denies a spawn whose parent is not in the canSpawn allowlist", () => {
    const decision = evaluateLocalAgentSpawnGate({
      targetAgentName: "builder",
      targetPolicy: { canSpawn: ["mavis", "orchestrator-x"] },
      parent: TASK_CHILD_SPAWN,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("orchestrator-x");
  });

  it("allows a spawn whose parent is named in the canSpawn allowlist", () => {
    expect(
      evaluateLocalAgentSpawnGate({
        targetAgentName: "builder",
        targetPolicy: { canSpawn: ["Orchestrator"] },
        parent: TASK_CHILD_SPAWN,
      }),
    ).toEqual({ allowed: true });
  });

  it("matches canSpawn entries against the parent, not the target", () => {
    // canSpawn names who may spawn the target; the target's own name is
    // never an entry match — a custom row named like a role must not inherit
    // the trusted builtin's allowlist.
    expect(
      evaluateLocalAgentSpawnGate({
        targetAgentName: "worker-clone",
        targetPolicy: { canSpawn: ["worker"] },
        parent: { parentIsTaskChild: true, parentAgentName: "worker" },
      }),
    ).toEqual({ allowed: true });
    const denied = evaluateLocalAgentSpawnGate({
      targetAgentName: "worker-clone",
      targetPolicy: { canSpawn: ["worker"] },
      parent: { parentIsTaskChild: true, parentAgentName: "worker-clone" },
    });
    expect(denied.allowed).toBe(false);
  });

  it("fails closed when a canSpawn allowlist exists and the parent is unknown", () => {
    const decision = evaluateLocalAgentSpawnGate({
      targetAgentName: "builder",
      targetPolicy: { canSpawn: ["mavis"] },
      parent: { parentIsTaskChild: true },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("parent Agent identity");
  });

  it("does not gate subagent-only targets at the task-spawn entry point", () => {
    expect(
      evaluateLocalAgentSpawnGate({
        targetAgentName: "deep-lab",
        targetPolicy: { spawnMode: "subagent-only" },
        parent: TASK_CHILD_SPAWN,
      }),
    ).toEqual({ allowed: true });
  });
});

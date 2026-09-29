import { describe, expect, it } from 'vitest';

import { LocalTurnPermissionGate } from './local-turn-permission-gate.js';

function gate(enforceBuiltinTools: boolean) {
  const checked: string[] = [];
  return {
    checked,
    gate: new LocalTurnPermissionGate({
      decisions: {
        async check(input) {
          checked.push(input.toolName);
          return { behavior: 'allow', reason: 'test allow' };
        },
      },
      enforceBuiltinTools,
    }),
  };
}

async function callBuiltinMatrix(subject: ReturnType<typeof gate>) {
  return subject.gate.beforeToolCall({
    sessionId: 'session',
    turnId: 'turn',
    agentName: 'main',
    model: 'test-model',
    toolContext: {
      toolCall: { id: 'call-1', name: 'web_search', source: 'builtin-matrix' },
      args: { query: 'example' },
    } as never,
  });
}

describe('TUI builtin catalog permission gate', () => {
  it('runs the shared engine for builtin-matrix tools when enforcement is on', async () => {
    const subject = gate(true);
    await expect(callBuiltinMatrix(subject)).resolves.toBeUndefined();
    expect(subject.checked).toEqual(['web_search']);
  });

  it('skips the engine only when a host explicitly disables builtin enforcement', async () => {
    const subject = gate(false);
    await expect(callBuiltinMatrix(subject)).resolves.toBeUndefined();
    expect(subject.checked).toEqual([]);
  });
});

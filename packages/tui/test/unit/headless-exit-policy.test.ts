import { describe, expect, it } from 'vitest';

import type { ExecResult } from '../../src/headless/contract.js';
import {
  MINIMAX_CODE_EXEC_EXIT_CODES,
  TuiExecError,
  exitCodeForExecError,
  exitCodeForExecResult,
} from '../../src/headless/exit-policy.js';

function result(fields: {
  status: ExecResult['status'];
  error?: ExecResult['error'];
}): ExecResult {
  return {
    schemaVersion: 1,
    type: 'exec.result',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ...fields,
  };
}

describe('mcode exec exit codes', () => {
  it('publishes the documented table and freezes it', () => {
    expect(MINIMAX_CODE_EXEC_EXIT_CODES).toEqual({
      success: 0,
      invocation: 2,
      config: 3,
      runtime: 4,
      timeout: 6,
      limit: 7,
      internal: 70,
      cancelled: 130,
      brokenPipe: 141,
    });
    expect(Object.isFrozen(MINIMAX_CODE_EXEC_EXIT_CODES)).toBe(true);
  });

  it('maps every run status onto its exit code', () => {
    expect(exitCodeForExecResult(result({ status: 'succeeded' }))).toBe(0);
    expect(exitCodeForExecResult(result({ status: 'timeout' }))).toBe(6);
    expect(exitCodeForExecResult(result({ status: 'cancelled' }))).toBe(130);
    expect(exitCodeForExecResult(result({ status: 'limit_exceeded' }))).toBe(7);
  });

  it('keeps a failed run distinguishable by error category', () => {
    const failed = (category: 'config' | 'runtime' | 'internal') =>
      exitCodeForExecResult(
        result({ status: 'failed', error: { category, message: 'failed' } }),
      );

    expect(failed('config')).toBe(3);
    expect(failed('runtime')).toBe(4);
    expect(failed('internal')).toBe(70);
    // A failed run that carries no category is treated as a runtime failure, not
    // as an internal one: the caller can retry it.
    expect(exitCodeForExecResult(result({ status: 'failed' }))).toBe(4);
  });

  it('maps thrown errors, and never reports success for an unknown failure', () => {
    expect(exitCodeForExecError(new TuiExecError('invocation', 'bad flag'))).toBe(2);
    expect(exitCodeForExecError(new TuiExecError('config', 'bad config'))).toBe(3);
    expect(exitCodeForExecError(new TuiExecError('runtime', 'provider down'))).toBe(4);
    expect(exitCodeForExecError(new TuiExecError('cancelled', 'interrupted'))).toBe(130);
    expect(exitCodeForExecError(new TuiExecError('brokenPipe', 'stdout closed'))).toBe(141);
    expect(exitCodeForExecError(new Error('unexpected'))).toBe(70);
    expect(exitCodeForExecError('not an error')).toBe(70);
  });
});

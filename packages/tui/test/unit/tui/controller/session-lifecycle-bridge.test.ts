import { describe, expect, it, vi } from 'vitest';

import { createTuiSessionLifecycleBridge } from '../../../../src/tui/controller/session-lifecycle-bridge.js';

describe('createTuiSessionLifecycleBridge.preparePluginHookSessionSwitch', () => {
  it('does not abort the previous Session when switching tabs (resume_other)', async () => {
    const abortSession = vi.fn(async () => true);
    const bridge = createTuiSessionLifecycleBridge({
      abortSession,
    } as never);

    await bridge.preparePluginHookSessionSwitch('session-running', 'resume_other');

    expect(abortSession).not.toHaveBeenCalled();
  });

  it('still aborts when the previous Session is cleared (/clear)', async () => {
    const abortSession = vi.fn(async () => true);
    const bridge = createTuiSessionLifecycleBridge({
      abortSession,
    } as never);

    await bridge.preparePluginHookSessionSwitch('session-cleared', 'clear');

    expect(abortSession).toHaveBeenCalledWith({
      id: 'session-cleared',
      reason: 'user_stop',
    });
  });
});

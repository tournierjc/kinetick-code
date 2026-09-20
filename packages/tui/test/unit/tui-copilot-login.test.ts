import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McodeCopilotOAuthStatus } from '../../src/provider/contract.js';
import { TuiCopilotLogin } from '../../src/tui/features/auth/copilot-login.js';
import { stripAnsi, visibleWidth } from '../../src/tui/rendering/text.js';

const disconnected: McodeCopilotOAuthStatus = {
  state: 'disconnected',
  providerId: 'github-copilot',
};
const device: McodeCopilotOAuthStatus = {
  state: 'pending',
  providerId: 'github-copilot',
  loginId: 'attempt-1',
  deviceCode: {
    verificationUri: 'https://github.com/login/device',
    userCode: 'ABCD-EFGH',
    expiresAt: Date.now() + 900_000,
  },
};

function harness(initial: McodeCopilotOAuthStatus = disconnected) {
  const application = {
    getCopilotOAuthStatus: vi.fn(
      async (): Promise<McodeCopilotOAuthStatus> => initial,
    ),
    connectCopilotOAuth: vi.fn(async (): Promise<McodeCopilotOAuthStatus> => device),
    cancelCopilotOAuthLogin: vi.fn(
      async (): Promise<McodeCopilotOAuthStatus> => disconnected,
    ),
  };
  const openExternalTarget = vi.fn(async () => undefined);
  const onConnected = vi.fn();
  const onClose = vi.fn();
  const panel = new TuiCopilotLogin({
    application,
    openExternalTarget,
    onConnected,
    onClose,
    requestRender: vi.fn(),
  });
  return {
    panel,
    application,
    openExternalTarget,
    onConnected,
    onClose,
    text: () => stripAnsi(panel.render(90).join('\n')),
  };
}

afterEach(() => vi.useRealTimers());

describe('Copilot sign-in panel', () => {
  it('starts the device flow on open and displays the code and link', async () => {
    vi.useFakeTimers();
    const h = harness();

    await h.panel.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.application.connectCopilotOAuth).toHaveBeenCalledOnce();
    expect(h.text()).toContain('Enter code: ABCD-EFGH');
    expect(h.text()).toContain('https://github.com/login/device');
    expect(h.text()).toContain('Waiting for authorization');
    expect(h.openExternalTarget).toHaveBeenCalledWith('https://github.com/login/device');
    h.panel.dispose();
  });

  it('polls until the account is connected, then hands back', async () => {
    vi.useFakeTimers();
    const h = harness();

    await h.panel.resume();
    h.application.getCopilotOAuthStatus.mockResolvedValue({
      ...disconnected,
      state: 'connected',
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.onConnected).toHaveBeenCalledOnce();
    h.panel.dispose();
  });

  it('resumes a pending device login without generating a second code', async () => {
    const h = harness(device);

    await h.panel.resume();

    expect(h.application.connectCopilotOAuth).not.toHaveBeenCalled();
    expect(h.text()).toContain('ABCD-EFGH');
    h.panel.handleInput('\u001b');
    await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
    expect(h.application.cancelCopilotOAuthLogin).toHaveBeenCalledWith('attempt-1');
    h.panel.dispose();
  });

  it('cancels an authorization that arrives after the user closes the panel', async () => {
    const h = harness();
    let release!: (status: McodeCopilotOAuthStatus) => void;
    h.application.connectCopilotOAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    await h.panel.resume();
    h.panel.handleInput('\u001b');
    h.panel.dispose();
    release(device);

    await vi.waitFor(() =>
      expect(h.application.cancelCopilotOAuthLogin).toHaveBeenCalledWith('attempt-1'),
    );
    expect(h.openExternalTarget).not.toHaveBeenCalled();
  });

  it('keeps the link visible when the browser cannot be opened', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.openExternalTarget.mockRejectedValue(new Error('xdg-open unavailable'));

    await h.panel.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.text()).toContain('Open the link above manually');
    h.panel.dispose();
  });

  it('shows the expiry, retries on Enter, and stops polling after disposal', async () => {
    vi.useFakeTimers();
    const h = harness(device);
    await h.panel.resume();

    h.application.getCopilotOAuthStatus.mockResolvedValue({
      ...disconnected,
      state: 'failed',
      error: 'Device code expired. Start sign-in again.',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.text()).toContain('Device code expired');

    h.panel.handleInput('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.application.connectCopilotOAuth).toHaveBeenCalledOnce();

    h.panel.dispose();
    const calls = h.application.getCopilotOAuthStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.application.getCopilotOAuthStatus).toHaveBeenCalledTimes(calls);
  });

  it('reports an unavailable connector instead of a blank screen', async () => {
    const h = harness({ state: 'hidden', providerId: 'github-copilot' });

    await h.panel.resume();

    expect(h.text()).toContain('Copilot sign-in is unavailable in this build.');
    expect(h.application.connectCopilotOAuth).not.toHaveBeenCalled();
    h.panel.dispose();
  });

  it('surfaces a rejected sign-in', async () => {
    const h = harness();
    h.application.connectCopilotOAuth.mockRejectedValue(
      new Error('Copilot sign-in failed.'),
    );

    await h.panel.resume();

    expect(h.text()).toContain('Copilot sign-in failed.');
    h.panel.dispose();
  });

  it('keeps the user code and cancel action visible in a narrow terminal', async () => {
    const h = harness(device);

    await h.panel.resume();
    const rows = h.panel.renderViewport(40, 12);
    const text = stripAnsi(rows.join('\n'));

    expect(text).toContain('ABCD-EFGH');
    expect(text).toContain('Esc cancel');
    expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(12);
    h.panel.dispose();
  });
});

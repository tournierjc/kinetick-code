import type { McodeProviderApplication } from '../../../provider/application.js';
import type { McodeCopilotOAuthStatus } from '../../../provider/contract.js';
import { getKeybindings, Key, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { wrapTextWithAnsi } from '../../rendering/text.js';
import { panelLayout } from '../../widgets/panel-frame.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

interface CopilotLoginOptions {
  application: Pick<
    McodeProviderApplication,
    'connectCopilotOAuth' | 'getCopilotOAuthStatus' | 'cancelCopilotOAuthLogin'
  >;
  openExternalTarget(url: string): Promise<void>;
  onConnected(): void;
  onClose(): void;
  requestRender(): void;
}

/**
 * GitHub Copilot sign-in, projected from the Runtime-owned login.
 *
 * Copilot authorizes through a device code and nothing else — there is no local
 * callback to wait on and no method to choose — so this screen starts the login
 * as soon as it opens and only reports the code to enter.
 */
export class TuiCopilotLogin implements Component {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private phase: 'loading' | 'starting' | 'waiting' | 'failed' = 'loading';
  private status: McodeCopilotOAuthStatus | undefined;
  private error: string | undefined;
  private browserHint: string | undefined;
  private openedUrl: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private cancelling = false;
  private starting = false;

  constructor(private readonly options: CopilotLoginOptions) {}

  async resume(): Promise<void> {
    try {
      const status = await this.options.application.getCopilotOAuthStatus();
      if (this.cancelling && status.loginId) {
        await this.options.application.cancelCopilotOAuthLogin(status.loginId);
      } else if (!this.disposed) {
        this.update(status);
        // A status read never waits on the sign-in itself: the poll that drives
        // this screen must keep ticking while the account authorizes.
        if (status.state === 'disconnected') void this.start();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  handleInput(data: string): void {
    if (this.disposed || this.cancelling) return;
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      void this.cancel();
    } else if (this.phase === 'failed' && matchesKey(data, Key.enter)) {
      void this.start();
    }
  }

  /** Nothing is cached: every render reads the current status. */
  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  async cancel(): Promise<void> {
    if (this.cancelling) return;
    this.cancelling = true;
    clearTimeout(this.timer);
    try {
      if (this.status?.loginId) {
        await this.options.application.cancelCopilotOAuthLogin(this.status.loginId);
      }
      if (!this.disposed) this.options.onClose();
    } catch (error) {
      this.cancelling = false;
      this.fail(error);
    }
  }

  render(width: number): string[] {
    return this.renderViewport(width, 20);
  }

  renderViewport(width: number, height: number): string[] {
    const footer =
      this.phase === 'failed' ? 'Enter retry · Esc cancel' : 'Esc cancel';
    const layout = panelLayout(width, height, footer);
    const body = this.body().flatMap((line) => wrapTextWithAnsi(line, layout.contentWidth));
    return layout.render({ title: 'Connect GitHub Copilot', body }, this.error ? 'error' : 'signal');
  }

  private body(): string[] {
    if (this.cancelling) return ['Cancelling sign-in…'];
    if (this.phase === 'loading') return ['Checking Copilot sign-in…'];
    if (this.phase === 'starting') return ['Starting Copilot sign-in…'];
    if (this.error) return [chalk.hex(colors.error)(this.error)];
    const device = this.status?.deviceCode;
    if (!device) return ['Waiting for authorization…'];
    return [
      chalk.bold.hex(colors.signal)(`Enter code: ${sanitizeTerminalText(device.userCode)}`),
      sanitizeTerminalText(device.verificationUri),
      'Open this link in a browser on your computer and enter the code.',
      'Waiting for authorization…',
      `Code expires in ${Math.max(0, Math.ceil((device.expiresAt - Date.now()) / 60_000))} min.`,
      ...(this.browserHint ? [this.browserHint] : []),
    ];
  }

  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.phase = 'starting';
    this.error = undefined;
    this.browserHint = undefined;
    this.options.requestRender();
    try {
      const status = await this.options.application.connectCopilotOAuth();
      if (this.cancelling && status.loginId) {
        await this.options.application.cancelCopilotOAuthLogin(status.loginId);
        return;
      }
      this.starting = false;
      if (!this.disposed) this.update(status);
    } catch (error) {
      this.starting = false;
      if (!this.cancelling) this.fail(error);
    }
  }

  private update(status: McodeCopilotOAuthStatus): void {
    if (this.cancelling) return;
    this.status = status;
    this.error = undefined;
    if (status.state === 'connected') {
      this.options.onConnected();
      return;
    }
    if (status.state === 'pending') {
      this.phase = 'waiting';
      const url = status.deviceCode?.verificationUri;
      if (url && url !== this.openedUrl) {
        this.openedUrl = url;
        void this.openBrowser(url);
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.resume();
      }, 1000);
      this.timer.unref?.();
    } else if (status.state === 'failed' || status.state === 'hidden') {
      this.phase = 'failed';
      this.error = sanitizeTerminalText(
        status.error ?? 'Copilot sign-in is unavailable in this build.',
      );
    } else {
      this.phase = 'loading';
    }
    this.options.requestRender();
  }

  private async openBrowser(url: string): Promise<void> {
    try {
      await this.options.openExternalTarget(url);
    } catch {
      if (this.disposed) return;
      this.browserHint = 'Open the link above manually to continue.';
      this.options.requestRender();
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.phase = 'failed';
    this.error = sanitizeTerminalText(
      error instanceof Error ? error.message : 'Copilot sign-in failed. Retry to continue.',
    );
    this.options.requestRender();
  }
}

import { getKeybindings, Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { sanitizeTuiUrl } from '../../rendering/url.js';
import { Input } from '../../widgets/input.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import {
  KCODE_DEEPSEEK_SETUP,
  KCODE_LOCAL_SETUP,
  KCODE_OPENROUTER_SETUP,
  type KcodeProviderModelInput,
  type KcodeProviderSnapshot,
  type KcodeProviderTestResult,
  type KcodeProviderView,
  type KcodeSaveProviderCandidateInput,
  type KcodeSaveProviderCandidateResult,
} from '../../../provider/contract.js';
import { TuiProviderEditor } from './editor.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

/**
 * `/provider` owns the independent Codex connect action and MiniMax credential
 * source. The MiniMax API Key can be replaced and OAuth can start a fresh
 * sign-in. OpenRouter and Local are listed before they are saved: OpenRouter
 * collects an API key, Local collects an OpenAI-compatible base URL and an
 * optional key, and both persist through the same candidate save as every
 * other custom connection. Every other connection the runtime resolves is
 * listed: the user's `custom_provider` entries are edited through
 * revision-checked candidate saves, and entries from the builtin `provider`
 * tree are shown and testable but owned by config.yaml. `a` connects a new
 * provider without leaving the panel.
 */
type ProviderManagerMode =
  | { readonly kind: 'list' }
  | { readonly kind: 'minimax-key'; readonly replacing: boolean }
  | { readonly kind: 'openrouter-key'; readonly apiKey?: string }
  | { readonly kind: 'openrouter-model'; readonly apiKey: string }
  | { readonly kind: 'deepseek-key'; readonly apiKey?: string }
  | { readonly kind: 'deepseek-model'; readonly apiKey: string }
  | { readonly kind: 'local-url' }
  | { readonly kind: 'local-model'; readonly baseUrl: string }
  | { readonly kind: 'local-key'; readonly baseUrl: string; readonly modelId: string };

export interface TuiProviderManagerOptions {
  snapshot: KcodeProviderSnapshot;
  onRefresh(): Promise<KcodeProviderSnapshot>;
  onRefreshModels?(provider: KcodeProviderView): Promise<number>;
  onTest(providerId: string, modelId?: string): Promise<KcodeProviderTestResult>;
  onConnectCodex?(): void;
  onConnectCopilot?(): void;
  /** Opens the known-provider catalogue; absent when the host cannot save one. */
  onAddProvider?(): void;
  onSaveCustom?(input: KcodeSaveProviderCandidateInput): Promise<KcodeSaveProviderCandidateResult>;
  onSetMiniMaxApiKey(apiKey: string): Promise<void>;
  onSetMiniMaxSource(source: 'token_plan' | 'minimax_api_key'): Promise<void>;
  /** Starts the same sign-in flow as `/login`; absent when the host has no auth. */
  onReLogin?(): void;
  onCancel(): void;
  requestRender(): void;
}

export class TuiProviderManager implements Component, Focusable {
  private editor?: TuiProviderEditor;
  private snapshotValue: KcodeProviderSnapshot;
  private selectedIndex = 0;
  private mode: ProviderManagerMode = { kind: 'list' };
  private readonly secretInput = new Input({ mask: '•' });
  private readonly textInput = new Input({ prompt: '' });
  /** Held only while a setup wizard can echo a failure that includes the secret. */
  private secretToRedact?: string;
  private busy = false;
  private status?: { readonly tone: 'info' | 'error'; readonly text: string };
  private _focused = false;
  private disposed = false;

  constructor(private readonly options: TuiProviderManagerOptions) {
    this.snapshotValue = options.snapshot;
    const activeIndex = this.providers().findIndex((provider) => provider.active);
    this.selectedIndex = Math.max(0, activeIndex);
    this.secretInput.onSubmit = (value) => {
      if (this.mode.kind === 'openrouter-key') this.submitOpenRouterKey(value);
      else if (this.mode.kind === 'deepseek-key') this.submitDeepSeekKey(value);
      else if (this.mode.kind === 'local-key') this.submitLocalKey(value);
      else this.submitMiniMaxKey(value);
    };
    this.secretInput.onEscape = () => this.exitSetupStep();
    this.textInput.onSubmit = (value) => this.submitSetupText(value);
    this.textInput.onEscape = () => this.exitSetupStep();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    if (this.editor) {
      this.editor.handleInput(data);
      return;
    }
    if (
      this.mode.kind === 'minimax-key' ||
      this.mode.kind === 'openrouter-key' ||
      this.mode.kind === 'deepseek-key' ||
      this.mode.kind === 'local-key'
    ) {
      this.secretInput.handleInput(data);
      this.requestRender();
      return;
    }
    if (
      this.mode.kind === 'openrouter-model' ||
      this.mode.kind === 'deepseek-model' ||
      this.mode.kind === 'local-url' ||
      this.mode.kind === 'local-model'
    ) {
      this.textInput.handleInput(data);
      this.requestRender();
      return;
    }
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.useSelected();
      return;
    }
    const key = data.toLowerCase();
    if (key === 'r') void this.refreshSelectedModels();
    else if (key === 't') void this.testSelected();
    else if (key === 'e') this.editSelected();
    else if (key === 'a') this.addProvider();
    else if (key === ' ') void this.useSelected();
  }

  invalidate(): void {
    this.secretInput.invalidate();
    this.textInput.invalidate();
    this.editor?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.mode = { kind: 'list' };
    this.secretToRedact = undefined;
    this.editor?.dispose();
    this.secretInput.focused = false;
    this.secretInput.setValue('');
    this.textInput.focused = false;
    this.textInput.setValue('');
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    if (this.editor) return this.editor.render(safeWidth);
    const lines =
      this.mode.kind === 'minimax-key'
        ? this.renderMiniMaxKey(safeWidth)
        : this.mode.kind === 'list'
          ? this.renderList(safeWidth)
          : this.renderSetup(safeWidth);
    return lines.map((line) => truncateToWidth(line, safeWidth, chalk.hex(colors.dim)('…')));
  }

  private renderList(width: number): string[] {
    const providers = this.providers();
    const lines = [
      frameTop(width),
      frameRow(
        composeLine(
          chalk.bold.hex(colors.signal)('Providers'),
          chalk.hex(colors.muted)('Model sources and credentials'),
          Math.max(1, width - 4),
        ),
        width,
      ),
      frameRow(
        chalk.hex(colors.dim)(
          'OpenRouter and DeepSeek take an API key. Local takes a server address. Keys stay masked.',
        ),
        width,
      ),
      frameDivider(width),
    ];
    for (const [index, provider] of providers.entries()) {
      const selected = index === this.selectedIndex;
      const sourceInUse = isSelectedSource(provider);
      const label = `${selected ? chalk.bold.hex(colors.signal)('›') : ' '} ${chalk.hex(
        sourceInUse ? colors.signal : colors.text,
      )(`${markerFor(provider)} ${sanitizeTerminalText(provider.name)}`)}`;
      lines.push(
        frameRow(
          composeLine(label, renderTuiActionHint(providerSummary(provider)), width - 4),
          width,
        ),
      );
    }
    const provider = this.selectedProvider();
    if (provider) {
      lines.push(frameDivider(width));
      lines.push(frameRow(renderTuiActionHint(providerDetail(provider)), width));
      if (showsConnectionDetails(provider)) {
        if (provider.kind !== 'copilot-oauth' && provider.baseUrl) {
          lines.push(frameRow(chalk.hex(colors.dim)(sanitizeTuiUrl(provider.baseUrl)), width));
        }
        const models = providerModelList(provider);
        if (models) lines.push(frameRow(chalk.hex(colors.dim)(models), width));
      }
    }
    if (this.status) {
      lines.push(
        frameRow(
          this.status.tone === 'error'
            ? chalk.hex(colors.error)(`! ${this.status.text}`)
            : chalk.hex(colors.accent)(`✓ ${this.status.text}`),
          width,
        ),
      );
    }
    lines.push(
      frameDivider(width),
      frameRow(
        renderTuiActionHint(this.busy ? 'Working…' : this.actionHint()),
        width,
      ),
      frameRow(
        chalk.hex(colors.dim)(
          this.options.onAddProvider
            ? 'OpenRouter and Local are in this list. a adds another provider from the catalog.'
            : 'Select a custom connection and press r to fetch its latest models.',
        ),
        width,
      ),
      frameBottom(width),
    );
    return lines;
  }

  private actionHint(): string {
    const actions = ['↑↓ move', 'Space use', 'r refresh models', 'e edit', 't test'];
    if (this.options.onAddProvider) actions.push('a add provider');
    return `${actions.join(' · ')} · Esc close`;
  }

  private renderMiniMaxKey(width: number): string[] {
    const replacing = this.mode.kind === 'minimax-key' && this.mode.replacing;
    return [
      frameTop(width),
      frameRow(
        chalk.bold.hex(colors.signal)(
          replacing ? 'Replace MiniMax API Key' : 'Configure MiniMax API Key',
        ),
        width,
      ),
      frameRow(
        chalk.hex(colors.muted)(
          replacing
            ? 'The saved key is overwritten once you submit.'
            : 'Saved locally and used instead of Token Plan.',
        ),
        width,
      ),
      frameDivider(width),
      frameRow(this.secretInput.render(Math.max(1, width - 8))[0] ?? '', width),
      ...(this.status ? [frameRow(chalk.hex(colors.error)(`! ${this.status.text}`), width)] : []),
      frameDivider(width),
      frameRow(renderTuiActionHint('Enter save and use · Esc cancel'), width),
      frameBottom(width),
    ];
  }

  private renderSetup(width: number): string[] {
    const copy = this.setupCopy();
    const input =
      this.mode.kind === 'openrouter-key' ||
      this.mode.kind === 'deepseek-key' ||
      this.mode.kind === 'local-key'
        ? this.secretInput
        : this.textInput;
    return [
      frameTop(width),
      frameRow(chalk.bold.hex(colors.signal)(copy.title), width),
      frameRow(chalk.hex(colors.muted)(copy.subtitle), width),
      frameDivider(width),
      frameRow(chalk.hex(colors.text)(copy.label), width),
      frameRow(input.render(Math.max(1, width - 8))[0] ?? '', width),
      ...(this.status ? [frameRow(chalk.hex(colors.error)(`! ${this.status.text}`), width)] : []),
      frameDivider(width),
      frameRow(renderTuiActionHint(this.busy ? 'Testing and saving…' : copy.footer), width),
      frameBottom(width),
    ];
  }

  private setupCopy(): { readonly title: string; readonly subtitle: string; readonly label: string; readonly footer: string } {
    if (this.mode.kind === 'openrouter-key') {
      return {
        title: 'Configure OpenRouter API Key',
        subtitle: this.mode.apiKey
          ? 'An API key is already entered. Submit empty to keep it, or type a replacement.'
          : `Saved locally and sent to ${KCODE_OPENROUTER_SETUP.baseUrl}.`,
        label: 'API Key',
        footer: 'Enter continue · Esc cancel',
      };
    }
    if (this.mode.kind === 'openrouter-model') {
      return {
        title: 'Choose an OpenRouter model',
        subtitle: 'Model id from the OpenRouter catalog, for example openai/gpt-4.1-mini.',
        label: 'Model ID',
        footer: 'Enter test, save, and use · Esc back',
      };
    }
    if (this.mode.kind === 'deepseek-key') {
      return {
        title: 'Configure DeepSeek API Key',
        subtitle: this.mode.apiKey
          ? 'An API key is already entered. Submit empty to keep it, or type a replacement.'
          : `Saved locally and sent to ${KCODE_DEEPSEEK_SETUP.baseUrl}.`,
        label: 'API Key',
        footer: 'Enter continue · Esc cancel',
      };
    }
    if (this.mode.kind === 'deepseek-model') {
      return {
        title: 'Choose a DeepSeek model',
        subtitle: 'Model id such as deepseek-chat or deepseek-reasoner.',
        label: 'Model ID',
        footer: 'Enter test, save, and use · Esc back',
      };
    }
    if (this.mode.kind === 'local-url') {
      return {
        title: 'Configure Local API address',
        subtitle: 'OpenAI-compatible base URL. The default is the address Ollama exposes.',
        label: 'Base URL',
        footer: 'Enter continue · Esc cancel',
      };
    }
    if (this.mode.kind === 'local-model') {
      return {
        title: 'Choose a Local model',
        subtitle: 'The id your server lists, for example qwen3.',
        label: 'Model ID',
        footer: 'Enter continue · Esc back',
      };
    }
    return {
      title: 'Local API Key (optional)',
      subtitle: 'Leave empty when the server does not check a credential.',
      label: 'API Key (optional)',
      footer: 'Enter connect · type a key for a guarded server · Esc back',
    };
  }

  private providers(): readonly KcodeProviderView[] {
    return this.snapshotValue.providers;
  }

  private selectedProvider(): KcodeProviderView | undefined {
    return this.providers()[this.selectedIndex];
  }

  private move(delta: number): void {
    this.selectedIndex = Math.max(
      0,
      Math.min(this.providers().length - 1, this.selectedIndex + delta),
    );
    this.status = undefined;
    this.requestRender();
  }

  private async refreshSelectedModels(): Promise<void> {
    const provider = this.selectedProvider();
    const refreshModels = this.options.onRefreshModels;
    if (!provider || provider.kind !== 'custom' || provider.readOnly || !refreshModels) {
      this.status = { tone: 'info', text: 'Select a custom connection to refresh its models.' };
      this.requestRender();
      return;
    }
    await this.perform(async () => {
      const count = await refreshModels(provider);
      try {
        await this.refresh(
          count
            ? `Added ${count} new model(s). Choose one with /model.`
            : 'Models are already up to date.',
        );
      } catch {
        this.setStatus(
          'Models were refreshed, but the list could not be reloaded. Reopen /provider.',
          'error',
        );
      }
    });
  }

  /** Custom rows open an editor; selecting them never silently changes credentials. */
  private async useSelected(): Promise<void> {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind === 'codex-oauth') {
      await this.connectCodex(provider);
      return;
    }
    if (provider.kind === 'copilot-oauth') {
      await this.connectCopilot(provider);
      return;
    }
    if (provider.kind === 'minimax-oauth') {
      await this.setMiniMaxSource('token_plan');
      return;
    }
    if (provider.kind === 'minimax-api-key') {
      if (!provider.hasApiKey) {
        this.startMiniMaxKey();
        return;
      }
      await this.setMiniMaxSource('minimax_api_key');
      return;
    }
    if (provider.kind === 'openrouter-setup') {
      this.startOpenRouterSetup();
      return;
    }
    if (provider.kind === 'deepseek-setup') {
      this.startDeepSeekSetup();
      return;
    }
    if (provider.kind === 'local-setup') {
      this.startLocalSetup();
      return;
    }
    if (provider.kind === 'builtin') {
      this.setStatus(
        `${provider.name} comes from config.yaml. Press t to test it, or choose one of its models in /model.`,
        'info',
      );
      return;
    }
    this.editSelected();
  }

  /**
   * `e` edits the credential behind the highlighted MiniMax row. OAuth has no
   * local secret to type, so it hands off to the same sign-in flow as
   * `/login`; the API Key row opens the masked input, replacing any saved key.
   */
  private editSelected(): void {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind === 'minimax-api-key') {
      this.startMiniMaxKey(provider.hasApiKey);
      return;
    }
    if (provider.kind === 'minimax-oauth') {
      if (!this.options.onReLogin) {
        this.setStatus('MiniMax sign-in is unavailable in this host.', 'error');
        return;
      }
      this.options.onReLogin();
      return;
    }
    if (provider.kind === 'codex-oauth') {
      this.setStatus('Use Enter or Space on the Codex row to start sign-in.', 'info');
      return;
    }
    if (provider.kind === 'copilot-oauth') {
      this.setStatus('Use Enter or Space on the GitHub Copilot row to start sign-in.', 'info');
      return;
    }
    if (provider.kind === 'openrouter-setup') {
      this.startOpenRouterSetup();
      return;
    }
    if (provider.kind === 'deepseek-setup') {
      this.startDeepSeekSetup();
      return;
    }
    if (provider.kind === 'local-setup') {
      this.startLocalSetup();
      return;
    }
    if (provider.kind === 'builtin') {
      this.setStatus(
        `${provider.name} is defined in config.yaml, where its key and endpoint live. Press a to connect it as a provider you manage here.`,
        'info',
      );
      return;
    }
    if (provider.readOnly || !this.options.onSaveCustom) {
      this.setStatus('This connection cannot be edited in this host.', 'info');
      return;
    }
    if (!provider.configRevision || !provider.baseUrl) {
      this.setStatus('Connection details are stale. Reopen /provider.', 'error');
      return;
    }
    this.editor = new TuiProviderEditor({
      provider,
      onSave: this.options.onSaveCustom,
      onSaved: (keyChanged) => {
        this.closeEditor();
        void this.perform(
          () =>
            this.refresh(
              keyChanged
                ? 'Connection saved. All its models now use the new API Key.'
                : 'Connection changes saved.',
            ),
          {
            summary: 'Connection saved, but the list could not refresh.',
            nextStep: 'Reopen /provider.',
          },
        );
      },
      onCancel: () => this.closeEditor(),
      requestRender: () => this.requestRender(),
    });
    this.syncFocus();
    this.requestRender();
  }

  private closeEditor(): void {
    this.editor?.dispose();
    this.editor = undefined;
    this.syncFocus();
    this.requestRender();
  }

  /**
   * `a` connects a new provider from here, using the same known-provider
   * catalogue the model picker offers — OpenRouter and the other pinned plans
   * included. The host closes this panel for the flow and reopens `/provider`
   * with the saved connection in the list.
   */
  private addProvider(): void {
    const addProvider = this.options.onAddProvider;
    if (!addProvider) {
      this.setStatus('Adding a provider is unavailable in this host.', 'error');
      return;
    }
    addProvider();
  }

  private async connectCodex(provider: KcodeProviderView): Promise<void> {
    const state = provider.status?.state;
    if (state === 'connected') {
      this.setStatus('OpenAI Codex is already connected.', 'info');
      return;
    }
    if (!this.options.onConnectCodex) {
      this.setStatus('Codex sign-in is unavailable in this host.', 'error');
      return;
    }
    this.options.onConnectCodex();
  }

  private async connectCopilot(provider: KcodeProviderView): Promise<void> {
    const state = provider.status?.state;
    if (state === 'connected') {
      this.setStatus('GitHub Copilot is already connected.', 'info');
      return;
    }
    if (!this.options.onConnectCopilot) {
      this.setStatus('Copilot sign-in is unavailable in this host.', 'error');
      return;
    }
    this.options.onConnectCopilot();
  }

  private startOpenRouterSetup(): void {
    this.mode = { kind: 'openrouter-key' };
    this.status = undefined;
    this.secretToRedact = undefined;
    this.secretInput.setValue('');
    this.secretInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private startDeepSeekSetup(): void {
    this.mode = { kind: 'deepseek-key' };
    this.status = undefined;
    this.secretToRedact = undefined;
    this.secretInput.setValue('');
    this.secretInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private startLocalSetup(): void {
    this.mode = { kind: 'local-url' };
    this.status = undefined;
    this.secretToRedact = undefined;
    this.textInput.setValue(KCODE_LOCAL_SETUP.baseUrl);
    this.textInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private submitOpenRouterKey(value: string): void {
    if (this.mode.kind !== 'openrouter-key') return;
    const apiKey = value.trim() || this.mode.apiKey;
    if (!apiKey) {
      this.setStatus('API key is required.', 'error');
      return;
    }
    this.secretToRedact = apiKey;
    this.mode = { kind: 'openrouter-model', apiKey };
    this.status = undefined;
    this.secretInput.setValue('');
    this.textInput.setValue('');
    this.textInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private submitDeepSeekKey(value: string): void {
    if (this.mode.kind !== 'deepseek-key') return;
    const apiKey = value.trim() || this.mode.apiKey;
    if (!apiKey) {
      this.setStatus('API key is required.', 'error');
      return;
    }
    this.secretToRedact = apiKey;
    this.mode = { kind: 'deepseek-model', apiKey };
    this.status = undefined;
    this.secretInput.setValue('');
    this.textInput.setValue('');
    this.textInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private submitSetupText(value: string): void {
    const trimmed = value.trim();
    if (this.mode.kind === 'openrouter-model') {
      if (!trimmed) {
        this.setStatus('Model ID is required.', 'error');
        return;
      }
      void this.saveSetup(openRouterSaveInput(this.mode.apiKey, trimmed), this.mode.apiKey);
      return;
    }
    if (this.mode.kind === 'deepseek-model') {
      if (!trimmed) {
        this.setStatus('Model ID is required.', 'error');
        return;
      }
      void this.saveSetup(deepSeekSaveInput(this.mode.apiKey, trimmed), this.mode.apiKey);
      return;
    }
    if (this.mode.kind === 'local-url') {
      if (!isHttpUrl(trimmed)) {
        this.setStatus('Base URL must use http or https.', 'error');
        return;
      }
      this.mode = { kind: 'local-model', baseUrl: trimmed };
      this.status = undefined;
      this.textInput.setValue('');
      this.textInput.moveCursorToEnd();
      this.syncFocus();
      this.requestRender();
      return;
    }
    if (this.mode.kind === 'local-model') {
      if (!trimmed) {
        this.setStatus('Model ID is required.', 'error');
        return;
      }
      this.mode = { kind: 'local-key', baseUrl: this.mode.baseUrl, modelId: trimmed };
      this.status = undefined;
      this.secretInput.setValue('');
      this.secretInput.moveCursorToEnd();
      this.syncFocus();
      this.requestRender();
    }
  }

  private submitLocalKey(value: string): void {
    if (this.mode.kind !== 'local-key') return;
    const apiKey = value.trim();
    if (apiKey) this.secretToRedact = apiKey;
    void this.saveSetup(
      localSaveInput(this.mode.baseUrl, this.mode.modelId, apiKey || undefined),
      apiKey || undefined,
    );
  }

  private async saveSetup(input: KcodeSaveProviderCandidateInput, secret?: string): Promise<void> {
    const save = this.options.onSaveCustom;
    if (!save) {
      this.setStatus('Saving a provider is unavailable in this host.', 'error');
      return;
    }
    if (secret) this.secretToRedact = secret;
    const name = input.name ?? 'Provider';
    await this.perform(
      async () => {
        let result: KcodeSaveProviderCandidateResult;
        try {
          result = await save(input);
        } catch (error) {
          if (this.disposed) return;
          this.setStatus(
            formatTuiActionFailure(error, {
              summary: `${name} was not saved.`,
              nextStep: 'Check the connection and retry.',
            }),
            'error',
          );
          return;
        }
        if (this.disposed) return;
        if (!result.success) {
          this.setStatus(
            formatTuiActionFailure(result.status?.lastErrorMessage ?? 'Connection test failed.', {
              summary: `${name} was not saved.`,
              nextStep: 'Check the URL, API key, and model ID, then retry.',
            }),
            'error',
          );
          return;
        }
        this.exitMode();
        await this.refresh(`${name} saved and selected.`);
        const index = this.providers().findIndex((provider) => provider.name === name);
        if (index >= 0) this.selectedIndex = index;
      },
      {
        summary: `${name} was saved, but the list could not refresh.`,
        nextStep: 'Reopen /provider.',
      },
    );
  }

  private startMiniMaxKey(replacing = false): void {
    this.mode = { kind: 'minimax-key', replacing };
    this.status = undefined;
    this.secretInput.setValue('');
    this.secretInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private submitMiniMaxKey(value: string): void {
    if (this.mode.kind !== 'minimax-key') return;
    const replacing = this.mode.replacing;
    if (!value.trim()) {
      this.setStatus('API key is required.', 'error');
      return;
    }
    void this.perform(async () => {
      await this.options.onSetMiniMaxApiKey(value.trim());
      if (this.disposed) return;
      await this.refresh(
        replacing
          ? 'MiniMax API Key replaced and selected.'
          : 'MiniMax API Key saved and selected.',
      );
      if (this.disposed) return;
      this.mode = { kind: 'list' };
    });
  }

  private async testSelected(): Promise<void> {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind === 'codex-oauth') {
      this.setStatus('Codex OAuth connectivity is managed by its sign-in flow.', 'info');
      return;
    }
    if (provider.kind === 'copilot-oauth') {
      this.setStatus('Copilot OAuth connectivity is managed by its sign-in flow.', 'info');
      return;
    }
    if (provider.kind === 'minimax-oauth') {
      this.setStatus('MiniMax OAuth sign-in and connectivity are managed by /login.', 'info');
      return;
    }
    if (provider.kind === 'openrouter-setup') {
      this.setStatus('Enter an OpenRouter API key before testing.', 'info');
      return;
    }
    if (provider.kind === 'deepseek-setup') {
      this.setStatus('Enter a DeepSeek API key before testing.', 'info');
      return;
    }
    if (provider.kind === 'local-setup') {
      this.setStatus('Enter a Local base URL before testing.', 'info');
      return;
    }
    await this.perform(async () => {
      const result = await this.options.onTest(provider.providerId);
      if (this.disposed) return;
      await this.refresh(
        result.success
          ? `${provider.name} connection is available.`
          : formatTuiActionFailure(result.status.lastErrorMessage ?? result.status.state, {
              summary: `${provider.name} connection test failed.`,
              nextStep: 'Check the URL, credentials, and model ID, then retry.',
            }),
        result.success ? 'info' : 'error',
      );
    });
  }

  private async setMiniMaxSource(source: 'token_plan' | 'minimax_api_key'): Promise<void> {
    await this.perform(async () => {
      await this.options.onSetMiniMaxSource(source);
      if (this.disposed) return;
      await this.refresh(
        source === 'token_plan' ? 'Using MiniMax Token Plan.' : 'Using MiniMax API Key.',
      );
    });
  }

  private async refresh(message: string, tone: 'info' | 'error' = 'info'): Promise<void> {
    const snapshot = await this.options.onRefresh();
    if (this.disposed) return;
    this.snapshotValue = snapshot;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.providers().length - 1));
    this.setStatus(message, tone);
  }

  private async perform(
    operation: () => Promise<void>,
    failure: { readonly summary: string; readonly nextStep: string } = {
      summary: 'The provider source was not changed.',
      nextStep: 'Retry, or manage providers in Settings.',
    },
  ): Promise<void> {
    this.busy = true;
    this.status = undefined;
    this.requestRender();
    try {
      await operation();
    } catch (error) {
      if (this.disposed) return;
      this.setStatus(
        formatTuiActionFailure(error, {
          summary: failure.summary,
          nextStep: failure.nextStep,
        }),
        'error',
      );
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.syncFocus();
        this.requestRender();
      }
    }
  }

  private exitSetupStep(): void {
    if (this.mode.kind === 'openrouter-model') {
      const apiKey = this.mode.apiKey;
      this.mode = { kind: 'openrouter-key', apiKey };
      this.status = undefined;
      this.secretInput.setValue('');
      this.syncFocus();
      this.requestRender();
      return;
    }
    if (this.mode.kind === 'deepseek-model') {
      const apiKey = this.mode.apiKey;
      this.mode = { kind: 'deepseek-key', apiKey };
      this.status = undefined;
      this.secretInput.setValue('');
      this.syncFocus();
      this.requestRender();
      return;
    }
    if (this.mode.kind === 'local-model') {
      const baseUrl = this.mode.baseUrl;
      this.mode = { kind: 'local-url' };
      this.status = undefined;
      this.textInput.setValue(baseUrl);
      this.textInput.moveCursorToEnd();
      this.syncFocus();
      this.requestRender();
      return;
    }
    if (this.mode.kind === 'local-key') {
      const { baseUrl, modelId } = this.mode;
      this.mode = { kind: 'local-model', baseUrl };
      this.status = undefined;
      this.secretInput.setValue('');
      this.textInput.setValue(modelId);
      this.textInput.moveCursorToEnd();
      this.syncFocus();
      this.requestRender();
      return;
    }
    this.exitMode();
  }

  private exitMode(): void {
    this.mode = { kind: 'list' };
    this.status = undefined;
    this.secretToRedact = undefined;
    this.secretInput.setValue('');
    this.textInput.setValue('');
    this.syncFocus();
    this.requestRender();
  }

  private setStatus(text: string, tone: 'info' | 'error'): void {
    const redacted = this.secretToRedact ? text.split(this.secretToRedact).join('[redacted]') : text;
    this.status = { text: sanitizeTerminalText(redacted), tone };
    this.requestRender();
  }

  private syncFocus(): void {
    const secret =
      this.mode.kind === 'minimax-key' ||
      this.mode.kind === 'openrouter-key' ||
      this.mode.kind === 'deepseek-key' ||
      this.mode.kind === 'local-key';
    const text =
      this.mode.kind === 'openrouter-model' ||
      this.mode.kind === 'deepseek-model' ||
      this.mode.kind === 'local-url' ||
      this.mode.kind === 'local-model';
    this.secretInput.focused = this._focused && secret && !this.editor;
    this.textInput.focused = this._focused && text && !this.editor;
    if (this.editor) this.editor.focused = this._focused;
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
}

/**
 * `●` answers one question only: which MiniMax credential source is in use.
 * A custom provider holding the selected model is a different fact, so it
 * never claims the glyph — rendering both made two rows look simultaneously
 * selected.
 */
function isSelectedSource(provider: KcodeProviderView): boolean {
  return (
    (provider.kind === 'minimax-oauth' || provider.kind === 'minimax-api-key') && provider.active
  );
}

function markerFor(provider: KcodeProviderView): string {
  if (provider.kind === 'codex-oauth' || provider.kind === 'copilot-oauth') {
    return provider.status?.state === 'connected' ? '✓' : '○';
  }
  if (provider.kind === 'custom' || provider.kind === 'builtin') {
    return provider.enabled ? '○' : '–';
  }
  return provider.active ? '●' : '○';
}

/**
 * Rows that describe an endpoint the runtime dials itself — a saved custom
 * connection, a builtin-tree one, or the Copilot connector's entry — carry a
 * base URL and a model roster worth printing. MiniMax's two credential sources
 * route through the managed gateway instead, and the Codex row's endpoint is
 * owned by its OAuth transport.
 */
function showsConnectionDetails(provider: KcodeProviderView): boolean {
  return (
    provider.kind === 'custom' ||
    provider.kind === 'builtin' ||
    provider.kind === 'copilot-oauth' ||
    provider.kind === 'openrouter-setup' ||
    provider.kind === 'deepseek-setup' ||
    provider.kind === 'local-setup'
  );
}

function providerModelList(provider: KcodeProviderView): string | undefined {
  if (provider.models.length === 0) return undefined;
  return sanitizeTerminalText(
    provider.models.map((model) => model.displayName ?? model.modelId).join(', '),
  );
}

function providerDetail(provider: KcodeProviderView): string {
  if (provider.kind === 'codex-oauth') {
    if (provider.status?.state === 'connected') return 'Connected with OpenAI OAuth';
    if (provider.status?.state === 'pending') {
      return 'Sign-in pending · Enter or Space to continue';
    }
    if (provider.status?.state === 'failed') {
      return `${provider.status.lastErrorMessage ?? 'Sign-in failed'} · Enter or Space to retry`;
    }
    return 'Not connected · Enter or Space to connect';
  }
  if (provider.kind === 'copilot-oauth') {
    // The connected row is the connector's own entry, so it also carries the
    // model roster the sign-in unlocked.
    const models = provider.models.length;
    const roster = models > 0 ? ` · ${models} model${models === 1 ? '' : 's'}` : '';
    if (provider.status?.state === 'connected') return `Connected with GitHub OAuth${roster}`;
    if (provider.status?.state === 'pending') {
      return `Sign-in pending · Enter or Space to continue${roster}`;
    }
    if (provider.status?.state === 'failed') {
      return `${provider.status.lastErrorMessage ?? 'Sign-in failed'} · Enter or Space to retry${roster}`;
    }
    return `Not connected · Enter or Space to connect${roster}`;
  }
  if (provider.kind === 'minimax-oauth') {
    return 'Sign-in managed by /login · Space to use · e to sign in again';
  }
  if (provider.kind === 'minimax-api-key') {
    return provider.hasApiKey
      ? `${provider.maskedApiKey ?? 'key saved'} · Space to use · e to replace`
      : 'No API key saved · Space or e to add one';
  }
  if (provider.kind === 'openrouter-setup') {
    return 'Not configured · Enter to set an API key';
  }
  if (provider.kind === 'deepseek-setup') {
    return 'Not configured · Enter to set an API key';
  }
  if (provider.kind === 'local-setup') {
    return 'Not configured · Enter to set a base URL';
  }
  return [
    provider.enabled ? 'Enabled' : 'Disabled',
    provider.apiFormat ?? 'anthropic-messages',
    provider.hasApiKey ? (provider.maskedApiKey ?? 'key saved') : 'no key sent',
    `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
  ].join(' · ');
}

function providerSummary(provider: KcodeProviderView): string {
  if (provider.kind === 'codex-oauth') {
    if (provider.status?.state === 'connected') return 'Connected';
    if (provider.status?.state === 'pending') return 'Waiting for sign-in';
    if (provider.status?.state === 'failed') return 'Sign-in failed';
    return 'Not connected';
  }
  if (provider.kind === 'copilot-oauth') {
    if (provider.status?.state === 'connected') return 'Connected';
    if (provider.status?.state === 'pending') return 'Waiting for sign-in';
    if (provider.status?.state === 'failed') return 'Sign-in failed';
    return 'Not connected';
  }
  if (provider.kind === 'minimax-oauth') {
    return provider.active ? 'Active · Token Plan' : 'Token Plan';
  }
  if (provider.kind === 'minimax-api-key') {
    return provider.hasApiKey
      ? provider.active
        ? 'Active · Key saved'
        : 'Key saved'
      : 'Not configured';
  }
  if (
    provider.kind === 'openrouter-setup' ||
    provider.kind === 'deepseek-setup' ||
    provider.kind === 'local-setup'
  ) {
    return 'Not configured';
  }
  return `${provider.enabled ? 'Enabled' : 'Disabled'} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`;
}

function openRouterSaveInput(apiKey: string, modelId: string): KcodeSaveProviderCandidateInput {
  return {
    name: KCODE_OPENROUTER_SETUP.name,
    baseUrl: KCODE_OPENROUTER_SETUP.baseUrl,
    apiKey,
    apiFormat: KCODE_OPENROUTER_SETUP.apiFormat,
    models: [manualModel(modelId)],
    modelId,
    saveAndUse: true,
  };
}

function deepSeekSaveInput(apiKey: string, modelId: string): KcodeSaveProviderCandidateInput {
  return {
    name: KCODE_DEEPSEEK_SETUP.name,
    baseUrl: KCODE_DEEPSEEK_SETUP.baseUrl,
    apiKey,
    apiFormat: KCODE_DEEPSEEK_SETUP.apiFormat,
    models: [manualModel(modelId)],
    modelId,
    saveAndUse: true,
  };
}

function localSaveInput(
  baseUrl: string,
  modelId: string,
  apiKey: string | undefined,
): KcodeSaveProviderCandidateInput {
  return {
    name: KCODE_LOCAL_SETUP.name,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    apiFormat: KCODE_LOCAL_SETUP.apiFormat,
    models: [manualModel(modelId)],
    modelId,
    saveAndUse: true,
  };
}

function manualModel(modelId: string): KcodeProviderModelInput {
  return {
    modelId,
    displayName: modelId,
    configurationSource: 'manual',
    toolCall: true,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function composeLine(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : truncateToWidth(left, width, '…');
}

function frameTop(width: number): string {
  if (width < 2) return '─'.repeat(Math.max(0, width));
  return chalk.hex(colors.line)(`╭${'─'.repeat(Math.max(0, width - 2))}╮`);
}

function frameDivider(width: number): string {
  if (width < 2) return '─'.repeat(Math.max(0, width));
  return chalk.hex(colors.line)(`├${'─'.repeat(Math.max(0, width - 2))}┤`);
}

function frameBottom(width: number): string {
  if (width < 2) return '─'.repeat(Math.max(0, width));
  return chalk.hex(colors.line)(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
}

function frameRow(content: string, width: number): string {
  if (width < 4) return truncateToWidth(content, width, '…');
  const innerWidth = width - 4;
  const fitted = truncateToWidth(content, innerWidth, '…');
  return `${chalk.hex(colors.line)('│')} ${fitted}${' '.repeat(
    Math.max(0, innerWidth - visibleWidth(fitted)),
  )} ${chalk.hex(colors.line)('│')}`;
}

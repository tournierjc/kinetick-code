export type KcodePluginMarketplace = 'official' | 'local';

export interface KcodePluginCapabilities {
  readonly appCount: number;
  readonly mcpServerCount: number;
  readonly skillCount: number;
}

export interface KcodePluginView {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly marketplace: KcodePluginMarketplace;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly capabilities: KcodePluginCapabilities;
}

export interface KcodePluginCatalog {
  readonly installed: readonly KcodePluginView[];
  readonly available: readonly KcodePluginView[];
}

export interface KcodePluginRuntimeAccess {
  listInstalledPlugins(input?: {
    readonly marketplace?: KcodePluginMarketplace;
  }): Promise<readonly KcodePluginView[]>;
  listMarketplacePlugins(input: {
    readonly marketplace: KcodePluginMarketplace;
  }): Promise<readonly KcodePluginView[]>;
  mutatePlugin(input: {
    readonly action: 'install' | 'remove' | 'enable' | 'disable';
    readonly plugin: { readonly name: string; readonly marketplace: KcodePluginMarketplace };
  }): Promise<{ readonly installed: boolean; readonly enabled: boolean }>;
  refreshPlugins(): Promise<void>;
}

export type KcodePluginCliRequest =
  | {
      readonly action: 'list';
      readonly marketplace?: KcodePluginMarketplace;
      readonly available?: boolean;
      readonly json?: boolean;
    }
  | {
      readonly action: 'add' | 'remove' | 'enable' | 'disable';
      readonly selector: string;
      readonly marketplace?: KcodePluginMarketplace;
      readonly json?: boolean;
    }
  | { readonly action: 'marketplace-list'; readonly json?: boolean }
  | {
      readonly action: 'marketplace-upgrade';
      readonly json?: boolean;
    };

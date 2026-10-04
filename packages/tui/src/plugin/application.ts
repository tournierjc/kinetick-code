import type {
  KcodePluginCatalog,
  KcodePluginMarketplace,
  KcodePluginRuntimeAccess,
  KcodePluginView,
} from './contract.js';

export class KcodePluginApplication {
  constructor(private readonly access: KcodePluginRuntimeAccess) {}

  async catalog(input: {
    readonly includeAvailable: boolean;
    readonly marketplace?: KcodePluginMarketplace;
  }): Promise<KcodePluginCatalog> {
    if (!input.includeAvailable) {
      return {
        installed: await this.access.listInstalledPlugins({
          marketplace: input.marketplace,
        }),
        available: [],
      };
    }
    const marketplaces: readonly KcodePluginMarketplace[] = input.marketplace
      ? [input.marketplace]
      : ['official', 'local'];
    const [installed, ...marketplaceCatalogs] = await Promise.all([
      this.access.listInstalledPlugins({ marketplace: input.marketplace }),
      ...marketplaces.map((marketplace) => this.access.listMarketplacePlugins({ marketplace })),
    ]);
    const merged = new Map(
      marketplaceCatalogs.flat().map((plugin) => [plugin.pluginId, plugin] as const),
    );
    for (const plugin of installed) merged.set(plugin.pluginId, plugin);
    return partitionCatalog([...merged.values()]);
  }

  install(plugin: KcodePluginView): Promise<KcodePluginView> {
    return this.mutate(plugin, 'install');
  }

  remove(plugin: KcodePluginView): Promise<KcodePluginView> {
    return this.mutate(plugin, 'remove');
  }

  setEnabled(plugin: KcodePluginView, enabled: boolean): Promise<KcodePluginView> {
    return this.mutate(plugin, enabled ? 'enable' : 'disable');
  }

  refresh(): Promise<void> {
    return this.access.refreshPlugins();
  }

  private async mutate(
    plugin: KcodePluginView,
    action: 'install' | 'remove' | 'enable' | 'disable',
  ): Promise<KcodePluginView> {
    const result = await this.access.mutatePlugin({
      action,
      plugin: { name: plugin.name, marketplace: plugin.marketplace },
    });
    return { ...plugin, ...result };
  }
}

function partitionCatalog(plugins: readonly KcodePluginView[]): KcodePluginCatalog {
  const installed: KcodePluginView[] = [];
  const available: KcodePluginView[] = [];
  for (const plugin of plugins) {
    (plugin.installed ? installed : available).push(plugin);
  }
  return { installed, available };
}

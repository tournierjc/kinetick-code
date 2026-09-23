import path from 'node:path';

import { KcodePluginApplication } from '../plugin/application.js';
import type {
  KcodePluginCatalog,
  KcodePluginCliRequest,
  KcodePluginMarketplace,
  KcodePluginView,
} from '../plugin/contract.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { createTuiRuntime, shutdownTuiRuntime } from '../runtime/lifecycle.js';

interface KcodePluginCommandApplication {
  catalog(input: {
    readonly includeAvailable: boolean;
    readonly marketplace?: KcodePluginMarketplace;
  }): Promise<KcodePluginCatalog>;
  install(plugin: KcodePluginView): Promise<KcodePluginView>;
  remove(plugin: KcodePluginView): Promise<KcodePluginView>;
  setEnabled(plugin: KcodePluginView, enabled: boolean): Promise<KcodePluginView>;
  refresh(): Promise<void>;
}

interface KcodePluginCommandContext {
  readonly application: KcodePluginCommandApplication;
  readonly dataDir: string;
  shutdown(): Promise<void>;
}

export interface RunKcodePluginCommandOptions {
  readonly version: string;
  readonly request: KcodePluginCliRequest;
  readonly lane?: string;
  readonly createContext?: (lane?: string) => Promise<KcodePluginCommandContext>;
}

export async function runKcodePluginCommand(
  options: RunKcodePluginCommandOptions,
): Promise<string> {
  const context = options.createContext
    ? await options.createContext(options.lane)
    : await createPluginCommandContext(options.version, options.lane);
  try {
    const request = options.request;
    if (request.action === 'marketplace-list') {
      const marketplaces = [
        { name: 'official', kind: 'registry' },
        { name: 'local', kind: 'directory', path: path.join(context.dataDir, 'plugins') },
      ];
      return request.json
        ? JSON.stringify(marketplaces, null, 2)
        : marketplaces
            .map(
              (entry) => `${entry.name}\t${entry.kind}${'path' in entry ? `\t${entry.path}` : ''}`,
            )
            .join('\n');
    }
    if (request.action === 'marketplace-upgrade') {
      await context.application.refresh();
      const result = { marketplace: 'all', refreshed: true };
      return request.json ? JSON.stringify(result, null, 2) : 'Refreshed all Plugin sources.';
    }
    if (request.action !== 'list') {
      const { name, marketplace } = parseSelector(request.selector, request.marketplace);
      const catalog = await context.application.catalog({
        includeAvailable: request.action === 'add',
        marketplace,
      });
      const plugin = selectPlugin(
        request.action === 'add' ? [...catalog.installed, ...catalog.available] : catalog.installed,
        name,
        marketplace,
      );
      const result =
        request.action === 'add'
          ? await context.application.install(plugin)
          : request.action === 'remove'
            ? await context.application.remove(plugin)
            : await context.application.setEnabled(plugin, request.action === 'enable');
      return request.json ? JSON.stringify(toCliPlugin(result), null, 2) : formatPlugin(result);
    }
    const catalog = await context.application.catalog({
      includeAvailable: Boolean(request.available),
      marketplace: request.marketplace,
    });
    if (request.json) {
      return JSON.stringify(
        {
          installed: catalog.installed.map(toCliPlugin),
          available: catalog.available.map(toCliPlugin),
        },
        null,
        2,
      );
    }
    return formatPluginRows(catalog);
  } finally {
    await context.shutdown();
  }
}

function toCliPlugin(plugin: KcodePluginView) {
  return {
    pluginId: plugin.pluginId,
    name: plugin.name,
    displayName: plugin.displayName,
    marketplaceName: plugin.marketplace,
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.author ? { author: plugin.author } : {}),
    installed: plugin.installed,
    enabled: plugin.enabled,
    capabilities: plugin.capabilities,
  };
}

function formatPluginRows(catalog: KcodePluginCatalog): string {
  return [...catalog.installed, ...catalog.available]
    .map((plugin) => {
      const marker = plugin.enabled ? '[*]' : plugin.installed ? '[-]' : '[ ]';
      const state = plugin.installed ? (plugin.enabled ? 'enabled' : 'disabled') : 'available';
      return `${marker} ${plugin.pluginId}\t${state}`;
    })
    .join('\n');
}

function formatPlugin(plugin: KcodePluginView): string {
  return formatPluginRows({
    installed: plugin.installed ? [plugin] : [],
    available: plugin.installed ? [] : [plugin],
  });
}

function parseSelector(
  selector: string,
  explicitMarketplace?: KcodePluginMarketplace,
): { readonly name: string; readonly marketplace?: KcodePluginMarketplace } {
  const match = /^([^@]+?)(?:@(official|local))?$/.exec(selector.trim());
  if (!match?.[1]) throw new Error(`Invalid Plugin selector: ${selector}`);
  const marketplace = match[2] as KcodePluginMarketplace | undefined;
  if (marketplace && explicitMarketplace && marketplace !== explicitMarketplace) {
    throw new Error(
      `Plugin selector marketplace conflicts with --marketplace ${explicitMarketplace}.`,
    );
  }
  return { name: match[1], marketplace: marketplace ?? explicitMarketplace };
}

function selectPlugin(
  plugins: readonly KcodePluginView[],
  name: string,
  marketplace?: KcodePluginMarketplace,
): KcodePluginView {
  const matches = plugins.filter(
    (plugin) =>
      plugin.name === name && (marketplace === undefined || plugin.marketplace === marketplace),
  );
  if (matches.length === 0)
    throw new Error(`Plugin not found: ${name}${marketplace ? `@${marketplace}` : ''}`);
  if (matches.length > 1) {
    throw new Error(
      `Plugin ${name} matches multiple marketplaces; use ${name}@official or ${name}@local.`,
    );
  }
  return matches[0] as KcodePluginView;
}

async function createPluginCommandContext(
  version: string = 'unknown',
  lane?: string,
): Promise<KcodePluginCommandContext> {
  const dataDir = await prepareTuiDataDir();
  const runtime = await createTuiRuntime({
    dataDir,
    workspaceDir: process.cwd(),
    version,
    surface: 'headless',
    ...(lane ? { lane } : {}),
  });
  return {
    application: new KcodePluginApplication(runtime.adapter),
    dataDir,
    shutdown: async () => {
      await shutdownTuiRuntime(runtime);
    },
  };
}

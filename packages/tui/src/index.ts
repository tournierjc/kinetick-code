#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  configureTuiRuntimeEnvironment,
  resolveTuiStartupEnvironmentOption,
} from './cli/environment.js';
import { prepareKcodePrefixProcess } from './update/prefix-update.js';
import { isInternalKcodePackageName, resolveKcodePackageName } from './update/install-source.js';

async function main(): Promise<void> {
  const packageName = resolveKcodePackageName(fileURLToPath(import.meta.url));
  const internalPackage = isInternalKcodePackageName(packageName);
  let startupBuildEnvironment: ReturnType<typeof resolveTuiStartupEnvironmentOption>;
  try {
    startupBuildEnvironment = resolveTuiStartupEnvironmentOption(
      process.argv.slice(2),
      internalPackage,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const { getTuiDataDirPath } = await import('./runtime/data-dir.js');
  configureTuiRuntimeEnvironment({
    dataDir: getTuiDataDirPath(),
    ...(startupBuildEnvironment ? { startupBuildEnvironment } : {}),
  });
  const prefixProcess = await prepareKcodePrefixProcess();
  try {
    // Default-deny egress: installed before any product module is imported, so
    // no request can be issued before the policy is in place.
    const { installTuiEgressGuard } = await import('./runtime/egress-guard.js');
    await installTuiEgressGuard();
    const { runTuiCli } = await import('./cli/main.js');
    await runTuiCli({ allowStartupEnvironmentSelection: internalPackage });
  } finally {
    prefixProcess.remove();
  }
}

await main();

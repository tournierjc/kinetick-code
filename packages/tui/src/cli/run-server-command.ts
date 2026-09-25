import type { Readable, Writable } from 'node:stream';

import { serveTuiServerHttp, type TuiServerLogger } from '../server/http.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import type {
  CreatedTuiRuntime,
  createTuiRuntime,
  shutdownTuiRuntime,
} from '../runtime/lifecycle.js';
import type { TuiServerLaunchRequest } from './contract.js';

type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface TuiServerProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(signal: TuiTerminationSignal, listener: () => void): unknown;
  off(signal: TuiTerminationSignal, listener: () => void): unknown;
}

export interface RunTuiServerCommandDependencies {
  readonly processRef?: TuiServerProcess;
  readonly workspaceDir?: () => string;
  readonly prepareDataDir?: typeof prepareTuiDataDir;
  readonly createRuntime?: typeof createTuiRuntime;
  readonly shutdownRuntime?: typeof shutdownTuiRuntime;
  readonly serve?: typeof serveTuiServerHttp;
  readonly logger?: TuiServerLogger;
  readonly loadRuntimeLifecycle?: () => Promise<{
    createTuiRuntime: typeof createTuiRuntime;
    shutdownTuiRuntime: typeof shutdownTuiRuntime;
  }>;
}

export async function runTuiServerCommand(
  request: TuiServerLaunchRequest,
  version: string,
  dependencies: RunTuiServerCommandDependencies = {},
  lane?: string,
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Session server is stopping.'));
  let runtime: CreatedTuiRuntime | undefined;
  let shutdownRuntime = dependencies.shutdownRuntime;
  processRef.once('SIGINT', cancel);
  processRef.once('SIGTERM', cancel);
  processRef.once('SIGHUP', cancel);
  try {
    const lifecycle =
      dependencies.createRuntime && dependencies.shutdownRuntime
        ? {
            createTuiRuntime: dependencies.createRuntime,
            shutdownTuiRuntime: dependencies.shutdownRuntime,
          }
        : await (dependencies.loadRuntimeLifecycle ?? (() => import('../runtime/lifecycle.js')))();
    const createRuntime = dependencies.createRuntime ?? lifecycle.createTuiRuntime;
    shutdownRuntime ??= lifecycle.shutdownTuiRuntime;
    const dataDir = await (dependencies.prepareDataDir ?? prepareTuiDataDir)();
    runtime = await createRuntime({
      dataDir,
      workspaceDir: (dependencies.workspaceDir ?? (() => process.cwd()))(),
      version,
      surface: 'server',
      ...(lane ? { lane } : {}),
    });
    await (dependencies.serve ?? serveTuiServerHttp)({
      runtime: runtime.adapter,
      version,
      host: request.host,
      port: request.port,
      signal: controller.signal,
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
  } finally {
    processRef.off('SIGINT', cancel);
    processRef.off('SIGTERM', cancel);
    processRef.off('SIGHUP', cancel);
    if (runtime && shutdownRuntime) await shutdownRuntime(runtime);
  }
}

import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import {
  resolveKCodeOAuthEndpointConfig,
  type KCodeOAuthEndpointEnvironment,
} from '@mavis/oauth-core';

import { createKcodeSharedAuthSession } from '../runtime/auth-session.js';
import { KcodeAuthApplication, type KcodeAuthApplicationOptions } from './application.js';
import { resolveKcodeAuthEnvironment } from './environment.js';
import { writeTuiRegionPreference } from './region-preference.js';

export interface CreateDefaultKcodeAuthApplicationOptions {
  dataDir: string;
  region?: MavisRegion;
  buildEnv?: MavisBuildEnv;
  oauthEndpointEnvironment?: KCodeOAuthEndpointEnvironment;
  createSharedSession?: typeof createKcodeSharedAuthSession;
  writeRegionPreference?: KcodeAuthApplicationOptions['writeRegionPreference'];
  sharedAuthCore?: KcodeAuthApplicationOptions['sharedAuthCore'];
}

export function createDefaultKcodeAuthApplication(
  options: CreateDefaultKcodeAuthApplicationOptions,
): KcodeAuthApplication {
  const environment = resolveKcodeAuthEnvironment({
    runtimeRegion: options.region,
    runtimeBuildEnv: options.buildEnv,
  });
  const region = options.region ?? environment.region;
  const buildEnv = options.buildEnv ?? environment.buildEnv;
  const applicationOptions = {
    dataDir: options.dataDir,
    region,
    buildEnv,
    writeRegionPreference: options.writeRegionPreference ?? writeTuiRegionPreference,
  } satisfies Omit<KcodeAuthApplicationOptions, 'sharedAuthCore'>;
  const createSharedAuthCore = (requestedRegion: MavisRegion) =>
    (options.createSharedSession ?? createKcodeSharedAuthSession)({
      dataDir: options.dataDir,
      region: requestedRegion,
      buildEnv,
      oauthEndpoints: resolveKCodeOAuthEndpointConfig(
        options.oauthEndpointEnvironment ?? process.env,
        { buildEnv, region: requestedRegion },
      ),
    });
  const sharedAuthCore = options.sharedAuthCore ?? createSharedAuthCore(region);
  return new KcodeAuthApplication({
    ...applicationOptions,
    sharedAuthCore,
    resolveSharedAuthCore: createSharedAuthCore,
  });
}

import { getRuntimeBuildEnv, type MavisBuildEnv, type MavisRegion } from '@mavis/config';
import {
  resolveProductBuildIdentity,
  type ProductBuildIdentity,
} from '@mavis/shared/product-build-identity';

export type TuiBuildEnvironment = 'test' | 'staging' | 'prod';
export type TuiBuildVariant = 'standard' | 'internal';
export type KcodeDataEnvironment = TuiBuildEnvironment | 'dev';

declare const __TUI_BUILD_ENV__: TuiBuildEnvironment | undefined;
declare const __TUI_BUILD_VARIANT__: TuiBuildVariant | undefined;

export interface ResolveKcodeAuthEnvironmentOptions {
  readonly embeddedBuildEnvironment?: TuiBuildEnvironment;
  readonly embeddedBuildVariant?: TuiBuildVariant;
  readonly runtimeRegion?: MavisRegion;
  readonly runtimeBuildEnv?: MavisBuildEnv;
}

export interface KcodeAuthEnvironment {
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
}

let startupBuildEnvironment: TuiBuildEnvironment | undefined;

export function setKcodeStartupBuildEnvironment(
  environment: TuiBuildEnvironment | undefined,
): void {
  startupBuildEnvironment = environment;
}

export function resolveKcodeBuildIdentity(
  options: ResolveKcodeAuthEnvironmentOptions = {},
): ProductBuildIdentity {
  const embeddedBuildEnvironment =
    options.embeddedBuildEnvironment ?? readEmbeddedBuildEnvironment();
  const embeddedBuildVariant = options.embeddedBuildVariant ?? readEmbeddedBuildVariant();
  const runtimeBuildEnv = options.runtimeBuildEnv ?? getRuntimeBuildEnv();

  return resolveProductBuildIdentity({
    buildEnv: embeddedBuildEnvironment ?? normalizeRuntimeBuildEnvironment(runtimeBuildEnv),
    internalBuild: embeddedBuildVariant === 'internal',
  });
}

export function resolveKcodeAuthEnvironment(
  options: ResolveKcodeAuthEnvironmentOptions = {},
): KcodeAuthEnvironment {
  const buildIdentity = resolveKcodeBuildIdentity(options);

  return {
    region: options.runtimeRegion ?? 'cn',
    buildEnv: startupBuildEnvironment ?? buildIdentity.buildEnv ?? 'test',
  };
}

export function resolveKcodeDataEnvironment(
  embeddedBuildEnvironment: TuiBuildEnvironment | undefined = readEmbeddedBuildEnvironment(),
): KcodeDataEnvironment {
  return startupBuildEnvironment ?? embeddedBuildEnvironment ?? 'dev';
}

function readEmbeddedBuildEnvironment(): TuiBuildEnvironment | undefined {
  if (typeof __TUI_BUILD_ENV__ === 'undefined') return undefined;
  return __TUI_BUILD_ENV__;
}

function readEmbeddedBuildVariant(): TuiBuildVariant | undefined {
  if (typeof __TUI_BUILD_VARIANT__ === 'undefined') return undefined;
  return __TUI_BUILD_VARIANT__;
}

function normalizeRuntimeBuildEnvironment(environment: MavisBuildEnv): MavisBuildEnv {
  return environment === 'dev' ? 'test' : environment;
}

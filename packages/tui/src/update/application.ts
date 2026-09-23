import {
  createMcodeNpmRuntimeEnvironment,
  detectMcodeInstallSource,
  resolveInstalledMcodePackageVersion,
  resolveMcodeInstallRoot,
  resolveMcodeNpmPrefixInstall,
  type McodeInstallSource,
  type McodeNpmPrefixInstall,
} from './install-source.js';
import {
  KCODE_RELEASES_URL,
  KcodeReleaseService,
  type KcodeReleaseApplyResult,
  type KcodeReleaseCheckResult,
  type KcodeReleaseInstallSource,
  type KcodeReleaseRequest,
} from './release.js';
import type { McodeUpdateOperationOptions } from './progress.js';

/**
 * Plan for an installation this build owns: a package-manager global install
 * updated from this repository's releases.
 */
export interface KcodeReleasePlan {
  readonly source: 'release';
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly channel: 'stable' | 'preview';
  readonly installSource: KcodeReleaseInstallSource;
  readonly artifactUrl: string;
}

export type McodeUpdatePlan =
  | (KcodeReleasePlan & { readonly kind: 'current' })
  | (KcodeReleasePlan & { readonly kind: 'ahead' })
  | (KcodeReleasePlan & { readonly kind: 'available' })
  | {
      readonly kind: 'manual';
      readonly source: 'unsupported';
      readonly currentVersion: string;
      readonly command: string;
    };

export interface McodeUpdateOutcome {
  readonly applied: boolean;
  readonly message: string;
  readonly restartRequired?: boolean;
}

export type McodeUpdateApplyOptions = McodeUpdateOperationOptions;

export interface McodeUpdateApplicationOptions {
  readonly currentVersion: string;
  readonly installRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly prefixInstall?: McodeNpmPrefixInstall;
  readonly entryFile?: string;
  readonly runtimeExecutable?: string;
}

/** Release channel as the application consumes it; injectable for tests. */
export interface ReleaseUpdateService {
  check(request?: KcodeReleaseRequest): Promise<KcodeReleaseCheckResult>;
  apply(request?: KcodeReleaseRequest): Promise<KcodeReleaseApplyResult>;
  resolveInstallCommand(request?: KcodeReleaseRequest): Promise<string>;
}

export interface McodeUpdateApplicationDependencies {
  readonly detectInstallSource: () => Promise<McodeInstallSource>;
  readonly createReleaseService: (source: KcodeReleaseInstallSource) => ReleaseUpdateService;
  readonly readInstalledPackageVersion: () => string | undefined;
}

/**
 * Resolve the update plan for the installation that owns this process and, on
 * request, apply it. Every installation a build of this repository can have is
 * a package-manager global install, updated from this repository's Releases
 * (see `release.ts`). A layout that belongs to another distributor is not
 * replaced in place: its launcher, receipts and metadata keys describe that
 * distributor, so the plan tells the user how to install this build instead.
 */
export class McodeUpdateApplication {
  private readonly currentVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly installEnvironment: NodeJS.ProcessEnv;
  private readonly installRoot: string;
  private readonly prefixInstall?: McodeNpmPrefixInstall;
  private readonly entryFile?: string;
  private readonly runtimeExecutable: string;
  private readonly dependencies: McodeUpdateApplicationDependencies;

  constructor(
    options: McodeUpdateApplicationOptions,
    dependencies: Partial<McodeUpdateApplicationDependencies> = {},
  ) {
    this.currentVersion = options.currentVersion;
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    this.platform = platform;
    this.environment = environment;
    this.installRoot = options.installRoot ?? resolveMcodeInstallRoot(environment);
    this.entryFile = options.entryFile ?? process.argv[1];
    this.runtimeExecutable = options.runtimeExecutable ?? process.execPath;
    this.prefixInstall =
      options.prefixInstall ?? resolveMcodeNpmPrefixInstall(this.entryFile, platform);
    // The install step has to build native dependencies against the Node that
    // runs this process, not against whichever npm the user's shell finds.
    this.installEnvironment = createMcodeNpmRuntimeEnvironment(
      environment,
      this.runtimeExecutable,
      platform,
    );
    this.dependencies = {
      detectInstallSource:
        dependencies.detectInstallSource ??
        (() =>
          detectMcodeInstallSource({
            installRoot: this.installRoot,
            platform,
            prefixInstall: () => this.prefixInstall,
          })),
      createReleaseService:
        dependencies.createReleaseService ??
        ((source) =>
          new KcodeReleaseService({
            currentVersion: options.currentVersion,
            installSource: source,
            installRoot: this.installRoot,
            environment,
            installEnvironment: this.installEnvironment,
            platform,
            dependencies: {
              readInstalledPackageVersion: this.dependencies.readInstalledPackageVersion,
            },
          })),
      readInstalledPackageVersion:
        dependencies.readInstalledPackageVersion ?? resolveInstalledMcodePackageVersion,
    };
  }

  async inspect(): Promise<McodeUpdatePlan> {
    const source = await this.dependencies.detectInstallSource();
    if (source === 'unsupported') {
      return {
        kind: 'manual',
        source,
        currentVersion: this.currentVersion,
        command: await this.resolveInstallCommand(),
      };
    }
    if (!isPackageManagerSource(source)) {
      throw new Error(unsupportedInstallationMessage(source));
    }
    const result = await this.dependencies.createReleaseService(source).check();
    return {
      kind: result.status,
      source: 'release',
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
      channel: result.channel,
      installSource: source,
      artifactUrl: result.release.artifact.downloadUrl,
    };
  }

  async apply(
    plan: McodeUpdatePlan,
    options: McodeUpdateApplyOptions = {},
  ): Promise<McodeUpdateOutcome> {
    if (plan.kind === 'manual' || plan.kind === 'current' || plan.kind === 'ahead') {
      throw new Error(`KCode update plan ${plan.kind} cannot be applied automatically.`);
    }
    const result = await this.dependencies.createReleaseService(plan.installSource).apply({
      channel: plan.channel,
      version: plan.latestVersion,
      ...options,
    });
    return result.applied
      ? {
          applied: true,
          restartRequired: result.restartRequired,
          message:
            `KCode ${result.latestVersion} is installed from ${KCODE_RELEASES_URL}. ` +
            'Restart running KCode sessions to use it.',
        }
      : {
          applied: false,
          message: `KCode ${result.currentVersion} is already active.`,
        };
  }

  /**
   * Manual command for an installation no package manager owns, such as a
   * source checkout: the exact command that installs the newest release.
   */
  private async resolveInstallCommand(): Promise<string> {
    try {
      return await this.dependencies.createReleaseService('npm-global').resolveInstallCommand();
    } catch {
      return (
        `download the newest archive from ${KCODE_RELEASES_URL} ` +
        'and install it with npm install --global'
      );
    }
  }
}

function isPackageManagerSource(source: McodeInstallSource): source is KcodeReleaseInstallSource {
  return (
    source === 'npm-global' ||
    source === 'pnpm-global' ||
    source === 'yarn-global' ||
    source === 'bun-global'
  );
}

/**
 * Why an installation is not updated in place. Both layouts carry another
 * distributor's identity: the upstream installer's launcher, receipts and
 * install metadata, or its versioned npm prefix, whose package validation this
 * build cannot satisfy. Replacing them in place would leave that distributor's
 * launcher active on the release it already points at, which is why the plan
 * names the manual install instead.
 */
function unsupportedInstallationMessage(source: McodeInstallSource): string {
  const layout =
    source === 'managed-installer'
      ? 'The upstream installer owns this installation, and its launcher, receipts and install ' +
        'metadata describe the upstream product; this build does not replace it in place. '
      : 'This installation is an npm prefix carrying the upstream installer layout, which this ' +
        'build does not replace in place. ';
  return (
    layout +
    `Install a release archive from ${KCODE_RELEASES_URL} with npm install --global, ` +
    'or keep this installation on the distribution it came from.'
  );
}

/** Channel a plan belongs to, for user-facing update messages. */
export function mcodeUpdateChannelLabel(plan: McodeUpdatePlan): string {
  if (plan.kind === 'manual') return 'the release channel';
  return `the ${plan.channel} channel`;
}

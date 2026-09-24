import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import type {
  AuthStatusSnapshot,
  DeviceAuthorizationPrompt,
  LoginOptions,
  LoginResult,
  LogoutResult,
} from '@mavis/oauth-core';

import { resolveKcodeAuthEnvironment } from './environment.js';
import { buildKcodeLogoutUrl } from './logout-url.js';

export type KcodeAuthProgress = {
  readonly state: 'device-authorization';
} & DeviceAuthorizationPrompt;

export interface KcodeAuthResult {
  readonly state: 'already-authenticated' | 'authenticated' | 'already-signed-out' | 'signed-out';
  readonly message: string;
  readonly restartRequired?: boolean;
  readonly logoutUrl?: string;
}

export interface KcodeAuthPort {
  login(
    onProgress?: (progress: KcodeAuthProgress) => void,
    region?: MavisRegion,
  ): Promise<KcodeAuthResult>;
  logout(): Promise<KcodeAuthResult>;
}

export interface KcodeSharedAuthCore {
  getStatus(): Promise<AuthStatusSnapshot>;
  login(options?: LoginOptions): Promise<LoginResult>;
  logout(options: { revoke: boolean }): Promise<LogoutResult>;
}

export interface KcodeAuthApplicationOptions {
  readonly dataDir: string;
  readonly sharedAuthCore: KcodeSharedAuthCore;
  readonly resolveSharedAuthCore?: (region: MavisRegion) => KcodeSharedAuthCore;
  readonly region?: MavisRegion;
  readonly buildEnv?: MavisBuildEnv;
  readonly writeRegionPreference?: (
    dataDir: string,
    preference: { region: MavisRegion; buildEnv: MavisBuildEnv },
  ) => unknown;
}

export class KcodeAuthApplication implements KcodeAuthPort {
  private readonly scope: { region: MavisRegion; buildEnv: MavisBuildEnv };

  constructor(private readonly options: KcodeAuthApplicationOptions) {
    const environment = resolveKcodeAuthEnvironment({
      runtimeRegion: process.env.MAVIS_REGION === 'en' ? 'en' : 'cn',
    });
    this.scope = {
      region: options.region ?? environment.region,
      buildEnv: options.buildEnv ?? environment.buildEnv,
    };
  }

  async login(
    onProgress?: (progress: KcodeAuthProgress) => void,
    region: MavisRegion = this.scope.region,
  ): Promise<KcodeAuthResult> {
    const requestedScope = { ...this.scope, region };
    const switchesRegion = !isSameScope(requestedScope, this.scope);
    let sharedAuthCore = this.options.sharedAuthCore;
    if (switchesRegion) {
      if (!this.options.resolveSharedAuthCore) {
        throw new Error(formatEnvironmentConflict(this.scope, requestedScope));
      }
      sharedAuthCore = this.options.resolveSharedAuthCore(region);
    }
    const wasAuthenticated = (await sharedAuthCore.getStatus()).status === 'authenticated';
    let deviceFlowStarted = false;
    await sharedAuthCore.login({
      onDeviceAuthorization: (authorization: DeviceAuthorizationPrompt) => {
        deviceFlowStarted = true;
        onProgress?.({ state: 'device-authorization', ...authorization });
      },
    });
    this.persistRegionPreference(requestedScope);
    const alreadyAuthenticated = wasAuthenticated && !deviceFlowStarted;
    const result = {
      state: alreadyAuthenticated
        ? ('already-authenticated' as const)
        : ('authenticated' as const),
      message: alreadyAuthenticated
        ? switchesRegion
          ? `Already signed in with ${formatRegion(requestedScope.region)}.`
          : 'Already signed in with MiniMax.'
        : switchesRegion
          ? `Signed in with ${formatRegion(requestedScope.region)}.`
          : 'Signed in with MiniMax.',
      ...(switchesRegion ? { restartRequired: true as const } : {}),
    };
    return result;
  }

  async logout(): Promise<KcodeAuthResult> {
    const status = await this.options.sharedAuthCore.getStatus();
    // Always run the shared logout: signing out while already signed out is a
    // safe no-op in the core, and never blocking /logout keeps a wedged local
    // state recoverable.
    const result = await this.options.sharedAuthCore.logout({ revoke: true });
    const logoutUrl = buildKcodeLogoutUrl(this.scope);
    if (status.status === 'anonymous' && result.status === 'anonymous') {
      return { state: 'already-signed-out', message: 'Already signed out of MiniMax.', logoutUrl };
    }
    return {
      state: 'signed-out',
      logoutUrl,
      message:
        result.status === 'logout_pending'
          ? `Signed out locally from ${formatRegion(this.scope.region)} across KCode. Server revocation is pending until the network recovers.`
          : `Signed out of ${formatRegion(this.scope.region)} on Desktop, CLI/TUI, and embedded mcode-tools.`,
    };
  }

  private persistRegionPreference(scope: { region: MavisRegion; buildEnv: MavisBuildEnv }): void {
    try {
      this.options.writeRegionPreference?.(this.options.dataDir, scope);
    } catch {
      // Region persistence must not invalidate an already completed OAuth login.
    }
  }

}

function isSameScope(
  left: { region: MavisRegion; buildEnv: MavisBuildEnv },
  right: { region: MavisRegion; buildEnv: MavisBuildEnv },
): boolean {
  return left.region === right.region && left.buildEnv === right.buildEnv;
}

function formatEnvironmentConflict(
  active: { region: MavisRegion; buildEnv: MavisBuildEnv },
  requested: { region: MavisRegion; buildEnv: MavisBuildEnv },
): string {
  if (active.region !== requested.region) {
    return `Signed in to ${formatRegion(active.region)}. Run \`kcode logout\` before signing in to ${formatRegion(requested.region)}.`;
  }
  return `Signed in to another MiniMax ${active.buildEnv} environment. Run \`kcode logout\` before signing in to ${requested.buildEnv}.`;
}

function formatRegion(region: MavisRegion): string {
  return region === 'cn' ? 'MiniMax China' : 'MiniMax Global';
}

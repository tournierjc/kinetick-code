export const KCODE_OAUTH_CLIENT_ID = 'mcode-public' as const;
export const KCODE_OAUTH_SCOPES = ['agent.default'] as const;
export const KCODE_OAUTH_AUDIENCE = 'agent-backend' as const;

export type AuthBuildEnv = 'dev' | 'test' | 'staging' | 'prod';
export type AuthRegion = 'cn' | 'en';

export interface AuthNamespaceInput {
  dataDir: string;
  buildEnv: AuthBuildEnv;
  region: AuthRegion;
}

export interface AccessTokenLease {
  accessToken: string;
  /** Stable across refresh, replaced by every interactive login. Absent on legacy credentials. */
  loginEpoch?: string;
  expiresAtMs: number;
  generation: number;
  scopes: typeof KCODE_OAUTH_SCOPES;
  audience: typeof KCODE_OAUTH_AUDIENCE;
}

export interface UnauthorizedContext {
  generation: number;
  loginEpoch?: string;
}

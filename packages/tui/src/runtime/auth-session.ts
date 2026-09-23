import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import {
  createAuthNamespace,
  createCredentialStore,
  HttpOAuthClient,
  migrateLegacyAuthNamespace,
  KCodeOAuthCore,
  type HttpOAuthClientOptions,
  type OAuthClient,
} from '@mavis/oauth-core';

export interface CreateKcodeSharedAuthSessionOptions {
  dataDir: string;
  region: MavisRegion;
  buildEnv: MavisBuildEnv;
  oauthClient?: OAuthClient;
  oauthEndpoints?: Pick<
    HttpOAuthClientOptions,
    'deviceAuthorizationEndpoint' | 'tokenEndpoint' | 'revocationEndpoint'
  >;
}

export function createKcodeSharedAuthSession(
  options: CreateKcodeSharedAuthSessionOptions,
): KCodeOAuthCore {
  const namespace = createAuthNamespace({
    dataDir: options.dataDir,
    buildEnv: options.buildEnv,
    region: options.region,
  });
  const oauthClient = options.oauthClient ?? createHttpOAuthClient(options.oauthEndpoints);
  const credentialStore = createCredentialStore({ authHome: namespace.namespaceHome });
  return new KCodeOAuthCore({
    namespace,
    oauthClient,
    credentialStore,
    initialize: () => migrateLegacyAuthNamespace(namespace),
  });
}

function createHttpOAuthClient(
  endpoints: CreateKcodeSharedAuthSessionOptions['oauthEndpoints'],
): HttpOAuthClient {
  if (!endpoints) {
    throw new TypeError(
      'Shared KCode OAuth requires explicit device authorization, token, and revocation endpoints.',
    );
  }
  return new HttpOAuthClient(endpoints);
}

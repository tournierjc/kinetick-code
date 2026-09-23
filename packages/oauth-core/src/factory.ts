import type { AuthNamespaceInput } from './contracts.js';
import { KCodeOAuthCore } from './auth-core.js';
import { createCredentialStore } from './credential-store/factory.js';
import { createAuthNamespace } from './namespace.js';
import { migrateLegacyAuthNamespace } from './namespace-migration.js';
import { HttpOAuthClient, type HttpOAuthClientOptions } from './oauth-client.js';
import {
  createAuthManager,
  createTokenProvider,
  type KCodeAuthManager,
  type KCodeTokenProvider,
} from './token-provider.js';

export interface CreateKCodeLocalAuthOptions extends AuthNamespaceInput {
  fetchImpl?: typeof fetch;
  endpoints: Pick<
    HttpOAuthClientOptions,
    | 'deviceAuthorizationEndpoint'
    | 'deviceAuthorizationHeaders'
    | 'tokenEndpoint'
    | 'revocationEndpoint'
  >;
}

export function createKCodeTokenProvider(options: CreateKCodeLocalAuthOptions): KCodeTokenProvider {
  return createTokenProvider(createCore(options));
}

export function createKCodeAuthManager(options: CreateKCodeLocalAuthOptions): KCodeAuthManager {
  return createAuthManager(createCore(options));
}

function createCore(options: CreateKCodeLocalAuthOptions): KCodeOAuthCore {
  const namespace = createAuthNamespace(options);
  return new KCodeOAuthCore({
    namespace,
    credentialStore: createCredentialStore({ authHome: namespace.namespaceHome }),
    oauthClient: new HttpOAuthClient({ ...options.endpoints, fetchImpl: options.fetchImpl }),
    initialize: () => migrateLegacyAuthNamespace(namespace),
  });
}

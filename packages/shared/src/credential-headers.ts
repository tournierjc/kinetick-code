/**
 * Credential headers on the provider request path.
 *
 * A model endpoint that needs no authentication must not receive a credential:
 * the three protocols this runtime drives carry one in `Authorization` or
 * `x-api-key`, and an empty placeholder sent in either place is a value the
 * endpoint never asked for.
 *
 * The provider SDKs make that awkward in the other direction — the vendored
 * transport refuses to build a client without a key at all — so the runtime
 * hands them a placeholder and clears these headers per request. A `null`
 * header value is what both SDKs read as "remove this default header"; they
 * apply their own credential header first, so the clear wins.
 */

/** Header names through which the supported protocols carry a credential. */
export const CREDENTIAL_HEADER_NAMES = ['authorization', 'x-api-key'] as const;

/**
 * Key handed to a transport that refuses to build a client without one when the
 * endpoint it talks to needs no authentication. It exists to satisfy that
 * requirement and is never meant to reach the wire: every request built for such
 * an endpoint clears the credential header the transport derives from it, and
 * the runtime's own auxiliary calls to the endpoint skip that credential too.
 */
export const UNAUTHENTICATED_PROVIDER_API_KEY = 'kcode-no-auth';

/**
 * Returns `headers` with every credential header cleared, except the ones the
 * caller declared itself — an explicit `Authorization` on a relay is that
 * connection's credential, not a default to clear.
 */
export function withClearedCredentialHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string | null> {
  const cleared: Record<string, string | null> = { ...(headers ?? {}) };
  const declared = new Set(Object.keys(cleared).map((name) => name.toLowerCase()));
  for (const name of CREDENTIAL_HEADER_NAMES) {
    if (!declared.has(name)) cleared[name] = null;
  }
  return cleared;
}

/**
 * Normalize a pasted or typed API key before storage or Authorization headers.
 *
 * Paste from dashboards and curl snippets often adds BOM/zero-width characters,
 * surrounding quotes, or a leading `Bearer ` prefix. Those produce a 401 that
 * looks like a revoked key even when the underlying secret is valid.
 */
export function sanitizeApiKeyCredential(apiKey: string): string {
  let value = typeof apiKey === 'string' ? apiKey : '';
  // Peel paste artifacts in layers: BOM/zero-width, quotes, and a leading Bearer
  // prefix commonly copied from curl examples. Order is intentional so both
  // `Bearer "sk-…"` and `"Bearer sk-…"` normalize to the raw key.
  for (let i = 0; i < 4; i += 1) {
    const before = value;
    value = value
      .replace(/\uFEFF/gu, '')
      .replace(/\u200B/gu, '')
      .replace(/\u200C/gu, '')
      .replace(/\u200D/gu, '')
      .replace(/\u2060/gu, '')
      .trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/^Bearer(?:\s+|$)/iu, '').trim();
    if (value === before) break;
  }
  return value;
}


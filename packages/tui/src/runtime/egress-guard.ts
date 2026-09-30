/**
 * TUI wiring for the default-deny egress guard.
 *
 * The guard itself is policy-agnostic (`@mavis/shared/egress-guard`); this
 * module supplies the one input the CLI owns: the origins the user declared as
 * model providers. Everything else — loopback, the managed-service deny list,
 * and `MCODE_ALLOWED_ORIGINS` — is resolved by the shared implementation.
 *
 * Installed once from the process entry point, before any product module is
 * imported, so no request can be issued before the policy is in place.
 */

import {
  installEgressGuard,
  type EgressAttempt,
  type EgressGuard,
} from '@mavis/shared/egress-guard';

export interface InstallTuiEgressGuardOptions {
  readonly environment?: Record<string, string | undefined>;
  readonly onBlocked?: (attempt: EgressAttempt) => void;
  /** Test seam: replaces the config read used to derive provider origins. */
  readonly resolveProviderOrigins?: () => Promise<readonly string[]> | readonly string[];
}

let installed: EgressGuard | undefined;

/** The guard installed by `installTuiEgressGuard`, for diagnostics and tests. */
export function tuiEgressGuard(): EgressGuard | undefined {
  return installed;
}

/** Test seam: forget the installed guard so a case can install its own. */
export function resetTuiEgressGuardForTest(): void {
  installed = undefined;
}

export async function installTuiEgressGuard(
  options: InstallTuiEgressGuardOptions = {},
): Promise<EgressGuard | undefined> {
  if (installed) return installed;
  const environment = options.environment ?? process.env;
  const providerOrigins = await resolveConfiguredProviderOrigins(
    options.resolveProviderOrigins,
  );
  const guard = installEgressGuard({
    environment,
    providerOrigins,
    ...(options.onBlocked ? { onBlocked: options.onBlocked } : {}),
  });
  installed = guard;
  return guard;
}

async function resolveConfiguredProviderOrigins(
  override: InstallTuiEgressGuardOptions['resolveProviderOrigins'],
): Promise<readonly string[]> {
  if (override) return await override();
  try {
    const { getConfig } = await import('@mavis/config');
    const config = getConfig() as unknown as Record<string, unknown>;
    return [
      ...collectBaseUrls(config.provider),
      ...collectBaseUrls(config.custom_provider),
    ];
  } catch {
    // An unreadable or not-yet-initialized config must not fail startup: the
    // guard stays stricter, not looser.
    return [];
  }
}

/** Collects `baseURL`/`base_url` string values from a provider-shaped value. */
function collectBaseUrls(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectBaseUrls(entry, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    if (key === 'baseURL' || key === 'base_url' || key === 'baseUrl') {
      return typeof entry === 'string' ? [entry] : [];
    }
    if (key === 'headers' || key === 'models') return [];
    return collectBaseUrls(entry, depth + 1);
  });
}

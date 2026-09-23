import type { McodeUpdatePlan } from './application.js';

export interface McodeStartupUpdateNotice {
  readonly latestVersion: string;
}

export function resolveMcodeStartupUpdateNotice(
  plan: McodeUpdatePlan,
): McodeStartupUpdateNotice | undefined {
  if (plan.kind !== 'available') return undefined;
  const latestVersion = plan.latestVersion.trim();
  return latestVersion ? { latestVersion } : undefined;
}

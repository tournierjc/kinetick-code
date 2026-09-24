import type { KcodeUpdatePlan } from './application.js';

export interface KcodeStartupUpdateNotice {
  readonly latestVersion: string;
}

export function resolveKcodeStartupUpdateNotice(
  plan: KcodeUpdatePlan,
): KcodeStartupUpdateNotice | undefined {
  if (plan.kind !== 'available') return undefined;
  const latestVersion = plan.latestVersion.trim();
  return latestVersion ? { latestVersion } : undefined;
}

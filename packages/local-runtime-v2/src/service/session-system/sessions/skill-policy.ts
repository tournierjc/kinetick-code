/**
 * Per-session Skill disposition: mandatory, optional, or forbidden.
 *
 * Unlisted Skills stay optional when `closed` is false (default open catalog).
 * When `closed` is true, only explicitly listed Skills are available — mandatory
 * and optional entries — and everything else is treated as forbidden for the
 * session.
 */

export type SessionSkillDisposition = 'mandatory' | 'optional' | 'forbidden';

export interface SessionSkillPolicy {
  readonly dispositions: Readonly<Record<string, SessionSkillDisposition>>;
  /** When true, Skills without an explicit disposition are unavailable. */
  readonly closed: boolean;
}

export type SessionSkillPolicyPatch = {
  readonly dispositions?: Readonly<Record<string, SessionSkillDisposition | null>>;
  readonly closed?: boolean;
};

export const DEFAULT_SESSION_SKILL_POLICY: SessionSkillPolicy = {
  dispositions: {},
  closed: false,
};

export function effectiveSessionSkillPolicy(
  policy: SessionSkillPolicy | undefined,
): SessionSkillPolicy {
  return policy ?? DEFAULT_SESSION_SKILL_POLICY;
}

export function applySessionSkillPolicyPatch(
  current: SessionSkillPolicy | undefined,
  patch: SessionSkillPolicyPatch,
): SessionSkillPolicy {
  const base = effectiveSessionSkillPolicy(current);
  const nextDispositions: Record<string, SessionSkillDisposition> = {
    ...base.dispositions,
  };
  if (patch.dispositions) {
    for (const [rawName, disposition] of Object.entries(patch.dispositions)) {
      const name = normalizeSkillPolicyName(rawName);
      if (!name) continue;
      if (disposition === null) {
        delete nextDispositions[name];
      } else {
        nextDispositions[name] = disposition;
      }
    }
  }
  return {
    dispositions: nextDispositions,
    closed: patch.closed ?? base.closed,
  };
}

export function dispositionForSkill(
  policy: SessionSkillPolicy | undefined,
  skillName: string,
): SessionSkillDisposition | 'hidden' {
  const effective = effectiveSessionSkillPolicy(policy);
  const name = normalizeSkillPolicyName(skillName);
  const explicit = name ? effective.dispositions[name] : undefined;
  if (explicit) return explicit;
  return effective.closed ? 'hidden' : 'optional';
}

export function isSkillAllowedBySessionPolicy(
  policy: SessionSkillPolicy | undefined,
  skillName: string,
): boolean {
  const disposition = dispositionForSkill(policy, skillName);
  return disposition === 'mandatory' || disposition === 'optional';
}

export function listSkillsByDisposition(
  policy: SessionSkillPolicy | undefined,
  disposition: SessionSkillDisposition,
): string[] {
  const effective = effectiveSessionSkillPolicy(policy);
  return Object.entries(effective.dispositions)
    .filter(([, value]) => value === disposition)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Compose an allowlist for Skill catalog filtering.
 *
 * - When the session policy is open and has no forbidden entries, returns
 *   `baseAllowed` unchanged (undefined means "all that pass other gates").
 * - Otherwise returns the intersection of the agent allowlist (if any) with
 *   Skills that the session policy permits, always including mandatory Skills.
 */
export function resolveSessionSkillAllowlist(
  policy: SessionSkillPolicy | undefined,
  baseAllowed: readonly string[] | undefined,
  catalogNames: readonly string[],
): readonly string[] | undefined {
  const effective = effectiveSessionSkillPolicy(policy);
  const hasRestrictions =
    effective.closed ||
    Object.values(effective.dispositions).some((value) => value === 'forbidden');
  if (!hasRestrictions && Object.keys(effective.dispositions).length === 0) {
    return baseAllowed;
  }

  const baseSet =
    baseAllowed === undefined
      ? undefined
      : new Set(baseAllowed.map(normalizeSkillPolicyName).filter(Boolean));
  const mandatory = new Set(listSkillsByDisposition(effective, 'mandatory'));
  const selected: string[] = [];
  for (const rawName of catalogNames) {
    const name = normalizeSkillPolicyName(rawName);
    if (!name) continue;
    if (!isSkillAllowedBySessionPolicy(effective, name)) continue;
    if (baseSet && !baseSet.has(name) && !mandatory.has(name)) continue;
    selected.push(name);
  }
  for (const name of mandatory) {
    if (!selected.includes(name) && (!baseSet || baseSet.has(name) || !baseSet)) {
      // Mandatory Skills override a closed agent allowlist only when they were
      // already in the catalog; callers pass catalogNames as the upper bound.
      if (catalogNames.some((candidate) => normalizeSkillPolicyName(candidate) === name)) {
        selected.push(name);
      }
    }
  }
  return [...new Set(selected)];
}

export function readSessionSkillPolicy(value: unknown, field: string): SessionSkillPolicy {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  const closed = requireBoolean(value.closed, `${field}.closed`);
  const dispositionsRaw = value.dispositions;
  if (!isPlainObject(dispositionsRaw)) {
    throw new Error(`${field}.dispositions must be an object`);
  }
  const dispositions: Record<string, SessionSkillDisposition> = {};
  for (const [rawName, rawDisposition] of Object.entries(dispositionsRaw)) {
    const name = normalizeSkillPolicyName(rawName);
    if (!name) continue;
    dispositions[name] = readDisposition(rawDisposition, `${field}.dispositions.${rawName}`);
  }
  return { dispositions, closed };
}

export function normalizeSkillPolicyName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function readDisposition(value: unknown, field: string): SessionSkillDisposition {
  if (value === 'mandatory' || value === 'optional' || value === 'forbidden') return value;
  throw new Error(`${field} must be mandatory, optional, or forbidden`);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

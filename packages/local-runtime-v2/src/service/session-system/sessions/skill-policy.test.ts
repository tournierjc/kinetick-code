import { describe, expect, it } from 'vitest';

import {
  applySessionSkillPolicyPatch,
  dispositionForSkill,
  isSkillAllowedBySessionPolicy,
  listSkillsByDisposition,
  resolveSessionSkillAllowlist,
} from './skill-policy.js';

describe('session skill policy', () => {
  it('defaults to open optional access', () => {
    expect(dispositionForSkill(undefined, 'pdf')).toBe('optional');
    expect(isSkillAllowedBySessionPolicy(undefined, 'pdf')).toBe(true);
  });

  it('supports mandatory, optional, and forbidden dispositions', () => {
    const policy = applySessionSkillPolicyPatch(undefined, {
      dispositions: {
        pdf: 'mandatory',
        xlsx: 'forbidden',
        docx: 'optional',
      },
    });
    expect(listSkillsByDisposition(policy, 'mandatory')).toEqual(['pdf']);
    expect(listSkillsByDisposition(policy, 'forbidden')).toEqual(['xlsx']);
    expect(isSkillAllowedBySessionPolicy(policy, 'pdf')).toBe(true);
    expect(isSkillAllowedBySessionPolicy(policy, 'xlsx')).toBe(false);
  });

  it('hides unlisted skills when closed', () => {
    const policy = applySessionSkillPolicyPatch(undefined, {
      closed: true,
      dispositions: { pdf: 'mandatory' },
    });
    expect(dispositionForSkill(policy, 'pdf')).toBe('mandatory');
    expect(dispositionForSkill(policy, 'xlsx')).toBe('hidden');
    expect(
      resolveSessionSkillAllowlist(policy, undefined, ['pdf', 'xlsx']),
    ).toEqual(['pdf']);
  });

  it('clears dispositions with null patches', () => {
    const policy = applySessionSkillPolicyPatch(
      {
        closed: false,
        dispositions: { pdf: 'forbidden' },
      },
      { dispositions: { pdf: null } },
    );
    expect(policy.dispositions).toEqual({});
    expect(isSkillAllowedBySessionPolicy(policy, 'pdf')).toBe(true);
  });
});

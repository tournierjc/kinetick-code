import { describe, expect, it } from 'vitest';

import {
  applySessionSkillPolicyPatch,
  dispositionForSkill,
  isSkillAllowedBySessionPolicy,
  listSkillsByDisposition,
  normalizeSkillPolicyName,
  readSessionSkillPolicy,
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
    expect(resolveSessionSkillAllowlist(policy, undefined, ['pdf', 'xlsx'])).toEqual(['pdf']);
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

  it('normalizes names and intersects agent allowlists with forbidden skills', () => {
    expect(normalizeSkillPolicyName('  PDF ')).toBe('pdf');
    const policy = applySessionSkillPolicyPatch(undefined, {
      dispositions: {
        PDF: 'forbidden',
        Review: 'mandatory',
      },
    });
    expect(policy.dispositions).toEqual({
      pdf: 'forbidden',
      review: 'mandatory',
    });
    expect(
      resolveSessionSkillAllowlist(policy, ['pdf', 'review', 'docs'], ['pdf', 'review', 'docs']),
    ).toEqual(['review', 'docs']);
  });

  it('returns base allowlist unchanged when unrestricted', () => {
    expect(resolveSessionSkillAllowlist(undefined, ['pdf'], ['pdf', 'xlsx'])).toEqual(['pdf']);
    expect(resolveSessionSkillAllowlist({ closed: false, dispositions: {} }, undefined, ['pdf'])).toBe(
      undefined,
    );
  });

  it('parses and validates persisted policy objects', () => {
    expect(
      readSessionSkillPolicy(
        {
          closed: true,
          dispositions: { pdf: 'mandatory', xlsx: 'forbidden' },
        },
        'skillPolicy',
      ),
    ).toEqual({
      closed: true,
      dispositions: { pdf: 'mandatory', xlsx: 'forbidden' },
    });
    expect(() => readSessionSkillPolicy('bad', 'skillPolicy')).toThrow(/must be an object/);
    expect(() =>
      readSessionSkillPolicy({ closed: true, dispositions: { pdf: 'maybe' } }, 'skillPolicy'),
    ).toThrow(/mandatory, optional, or forbidden/);
    expect(() =>
      readSessionSkillPolicy({ closed: 'yes', dispositions: {} }, 'skillPolicy'),
    ).toThrow(/closed must be a boolean/);
  });
});

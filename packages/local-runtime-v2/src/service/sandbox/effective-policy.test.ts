import { getSandboxConfigDefaults } from '@mavis/config';
import { describe, expect, it } from 'vitest';

import { compileSandboxEffectivePolicy } from './effective-policy.js';

describe('sandbox effective policy', () => {
  it('defaults to an unsandboxed host shell', () => {
    const defaults = getSandboxConfigDefaults('linux');
    expect(defaults.enabled).toBe(false);
    expect(defaults.filesystem.policy.mode).toBe('full_access');
    expect(defaults.network.policy.mode).toBe('allow_all');
  });

  it('does not enforce a saved network deny list', () => {
    const policy = compileSandboxEffectivePolicy({
      enabled: true,
      filesystem: {
        policy: { mode: 'workspace_write' },
        denyRead: [],
        denyWrite: [],
      },
      network: {
        policy: { mode: 'deny' },
        deniedDomains: ['169.254.169.254'],
      },
      localAccess: 'open',
    });
    expect(policy.enabled).toBe(true);
    expect(policy.filesystem.mode).toBe('workspace_write');
    expect(policy.network).toEqual({
      mode: 'deny',
      enforce: false,
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowAll: true,
    });
  });
});

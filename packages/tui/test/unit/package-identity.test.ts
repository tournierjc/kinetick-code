import { describe, expect, it } from 'vitest';
import {
  KCODE_INSTALLABLE_PACKAGE_NAMES,
  KCODE_LEGACY_PACKAGE_NAMES,
  KCODE_PACKAGE_DIR_PATTERN,
  KCODE_PACKAGE_NAME,
  KCODE_PACKAGE_NAMES,
  KCODE_WORKSPACE_PACKAGE_NAME,
  isInternalKcodePackageName,
  isKcodePackageName,
} from '../../src/package-identity.js';
import { KCODE_PACKAGE_NAME as BUILD_PACKAGE_NAME } from '../../src/build-info.js';

describe('KCode package identity', () => {
  it("installs under the product's own name", () => {
    expect(KCODE_PACKAGE_NAME).toBe('kinetick-code');
    expect(KCODE_PACKAGE_NAMES[0]).toBe(KCODE_PACKAGE_NAME);
  });

  it('accepts the workspace and historical identities, current identity first', () => {
    expect(KCODE_PACKAGE_NAMES).toEqual([
      'kinetick-code',
      '@mavis/code',
      '@minimax-ai/code',
      '@minimax/code',
    ]);
    expect(KCODE_WORKSPACE_PACKAGE_NAME).toBe('@mavis/code');
    expect(KCODE_LEGACY_PACKAGE_NAMES).toEqual(['@minimax-ai/code', '@minimax/code']);
  });

  it.each([...KCODE_PACKAGE_NAMES])('recognizes %s as this product', (name) => {
    expect(isKcodePackageName(name)).toBe(true);
  });

  it.each([
    '@minimax-ai/mcode-tools',
    '@mavis/other',
    'kinetick-code-cli',
    'minimax-code',
    'kcode',
    '',
  ])('does not recognize %s as this product', (name) => {
    expect(isKcodePackageName(name)).toBe(false);
  });

  it('rejects non-string package names', () => {
    expect(isKcodePackageName(undefined)).toBe(false);
    expect(isKcodePackageName(null)).toBe(false);
    expect(isKcodePackageName(42)).toBe(false);
  });

  it('treats only the workspace identities as internal', () => {
    expect(isInternalKcodePackageName('@mavis/code')).toBe(true);
    expect(isInternalKcodePackageName('@minimax/code')).toBe(true);
    expect(isInternalKcodePackageName('kinetick-code')).toBe(false);
    expect(isInternalKcodePackageName('@minimax-ai/code')).toBe(false);
    expect(isInternalKcodePackageName(undefined)).toBe(false);
  });

  it('allows install scripts for the names an archive can carry', () => {
    expect(KCODE_INSTALLABLE_PACKAGE_NAMES).toEqual(['kinetick-code', '@minimax-ai/code']);
  });

  it('matches a package directory of either shape', () => {
    const pattern = new RegExp(`/node_modules/${KCODE_PACKAGE_DIR_PATTERN}$`, 'u');
    expect(pattern.test('/usr/local/lib/node_modules/kinetick-code')).toBe(true);
    expect(pattern.test('C:\\apps\\node_modules\\kinetick-code'.replaceAll('\\', '/'))).toBe(true);
    expect(pattern.test('/usr/local/lib/node_modules/@minimax-ai/code')).toBe(true);
    expect(pattern.test('/usr/local/lib/node_modules/@minimax/code')).toBe(true);
    expect(pattern.test('/usr/local/lib/node_modules/@mavis/code')).toBe(true);
    expect(pattern.test('/usr/local/lib/node_modules/@minimax-ai/mcode-tools')).toBe(false);
    expect(pattern.test('/usr/local/lib/node_modules/kinetick-code/dist')).toBe(false);
  });

  it('uses the same name in the CLI and in the build and release scripts', async () => {
    const scriptIdentity = (await import('../../../../scripts/lib/package-identity.mjs')) as {
      PACKAGE_NAME: string;
      WORKSPACE_PACKAGE_NAME: string;
      LEGACY_PACKAGE_NAMES: readonly string[];
    };
    expect(scriptIdentity.PACKAGE_NAME).toBe(KCODE_PACKAGE_NAME);
    expect(scriptIdentity.WORKSPACE_PACKAGE_NAME).toBe(KCODE_WORKSPACE_PACKAGE_NAME);
    expect([...scriptIdentity.LEGACY_PACKAGE_NAMES]).toEqual([...KCODE_LEGACY_PACKAGE_NAMES]);
    expect(BUILD_PACKAGE_NAME).toBe(KCODE_PACKAGE_NAME);
  });
});

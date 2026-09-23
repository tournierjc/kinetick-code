/**
 * Installed package identities.
 *
 * This product installs under its own name. The names earlier releases and the
 * upstream CLI used are still recognized so an existing installation is
 * classified instead of being reported as a foreign package, but nothing in the
 * build writes them any more.
 */

/** Name this product installs as; matches the release archive and the repository. */
export const KCODE_PACKAGE_NAME = 'kinetick-code';

/** Package name of the CLI package inside this workspace, used by source checkouts. */
export const KCODE_WORKSPACE_PACKAGE_NAME = '@mavis/code';

/** Identities earlier releases and the upstream CLI installed under. */
export const KCODE_LEGACY_PACKAGE_NAMES = ['@minimax-ai/code', '@minimax/code'] as const;

/**
 * Identities an install command may need to name: this product's own, plus the
 * name it was distributed under before it took one, because the updater also
 * installs archives published under that name.
 */
export const KCODE_INSTALLABLE_PACKAGE_NAMES = [KCODE_PACKAGE_NAME, '@minimax-ai/code'] as const;

/** Every identity that is this product, current first. */
export const KCODE_PACKAGE_NAMES = [
  KCODE_PACKAGE_NAME,
  KCODE_WORKSPACE_PACKAGE_NAME,
  ...KCODE_LEGACY_PACKAGE_NAMES,
] as const;

export type KcodePackageName = (typeof KCODE_PACKAGE_NAMES)[number];

/**
 * Identities that mean a source checkout or a development install, rather than a
 * released build. Such an installation may select its account environment.
 */
export const KCODE_INTERNAL_PACKAGE_NAMES = [
  KCODE_WORKSPACE_PACKAGE_NAME,
  '@minimax/code',
] as const;

export function isKcodePackageName(value: unknown): value is KcodePackageName {
  return typeof value === 'string' && (KCODE_PACKAGE_NAMES as readonly string[]).includes(value);
}

export function isInternalKcodePackageName(packageName: string | undefined): boolean {
  return (
    packageName !== undefined &&
    (KCODE_INTERNAL_PACKAGE_NAMES as readonly string[]).includes(packageName)
  );
}

/**
 * Regular-expression fragment matching the package directory of any accepted
 * identity, for the `node_modules/<...>` tail of a package-manager install.
 * Unscoped `kinetick-code` and the scoped identities are both accepted, so an
 * installation made before this product took its own name stays recognizable.
 */
export const KCODE_PACKAGE_DIR_PATTERN =
  '(?:kinetick-code|@(?:mavis|minimax(?:-ai)?)/code)';

/**
 * Installed package identities, shared by the build and release scripts.
 *
 * `packages/tui/src/package-identity.ts` holds the same names for the CLI, and a
 * unit test compares the two so they cannot drift apart.
 */

/** Name this product installs as; matches the release archive and the repository. */
export const PACKAGE_NAME = 'kinetick-code';

/** Package name of the CLI package inside this workspace, used by source checkouts. */
export const WORKSPACE_PACKAGE_NAME = '@mavis/code';

/** Identities earlier releases and the upstream CLI installed under. */
export const LEGACY_PACKAGE_NAMES = ['@minimax-ai/code', '@minimax/code'];

import { readFileSync } from 'node:fs';

import { KCODE_PACKAGE_NAME, isKcodePackageName } from './package-identity.js';

export { KCODE_PACKAGE_NAME };

export const KCODE_MIN_NODE_VERSION = '22.19.0';
export const KCODE_SUPPORTED_NODE_VERSIONS = '22.19+, 24, 25, or 26';
export const TUI_BUILD_PROFILE = 'tui';

interface PackageManifest {
  name: string;
  version: string;
}

export function resolveTuiPackageVersion(moduleUrl: string | URL = import.meta.url): string {
  for (const relativePath of ['./package.json', '../package.json']) {
    try {
      const manifest = JSON.parse(
        readFileSync(new URL(relativePath, moduleUrl), 'utf8'),
      ) as Partial<PackageManifest>;
      if (
        isKcodePackageName(manifest.name) &&
        typeof manifest.version === 'string' &&
        manifest.version.length > 0
      ) {
        return manifest.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Cannot resolve ${KCODE_PACKAGE_NAME} package version`);
}

function parseVersion(version: string): number[] | undefined {
  const parts = version.split('.');
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  return parts.map((part) => Number.parseInt(part, 10));
}

export function supportsTuiNodeVersion(version = process.versions.node): boolean {
  const currentParts = parseVersion(version);
  if (!currentParts) return false;

  const [major = -1, minor = 0] = currentParts;
  return (major === 22 && minor >= 19) || (major >= 24 && major <= 26);
}

export const KCODE_VERSION = resolveTuiPackageVersion();

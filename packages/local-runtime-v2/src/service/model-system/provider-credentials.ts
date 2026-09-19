/**
 * Pi stores every provider's credentials — OAuth entries and plain keys — in one
 * profile-scoped AuthStorage file, and the runtime's `providerAuthGetter` reads
 * that file by provider id. Every connector therefore shares this store instead
 * of adding a second one per provider.
 *
 * The file name predates the second connector and is kept as-is: renaming it
 * would strand existing Codex credentials in a file nothing reads.
 * `packages/local-runtime`'s provider credential readers open the same file.
 */
export const PROVIDER_CREDENTIALS_FILE = 'codex-auth.json';

/**
 * User-facing text for the one installer-journal action this build still takes:
 * a pending update staged by an earlier installation is scheduled when the CLI
 * starts. The messages that described staging and activating a versioned npm
 * prefix went with that update path.
 */
export function kcodePrefixActivationScheduledMessage(
  _environment: NodeJS.ProcessEnv = process.env,
): string {
  return 'A staged KCode update will activate after this process exits.';
}

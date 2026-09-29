import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_SERVER_TOKEN_FILE = 'session-server.token';

const MIN_SESSION_SERVER_TOKEN_LENGTH = 16;
const MAX_SESSION_SERVER_TOKEN_LENGTH = 256;

/** 32 random bytes, base64url, with no padding. Suitable as a bearer token. */
export function createSessionServerToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Accept an operator-supplied token. Rejects short values, whitespace, and
 * non-ASCII so the token can live in one Authorization header field.
 */
export function assertSessionServerToken(token: string): void {
  if (
    token.length < MIN_SESSION_SERVER_TOKEN_LENGTH ||
    token.length > MAX_SESSION_SERVER_TOKEN_LENGTH ||
    /[^\x21-\x7e]/u.test(token)
  ) {
    throw new Error(
      'Session server token must be 16 to 256 printable ASCII characters without spaces.',
    );
  }
}

export function sessionServerTokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function bearerTokenFromAuthorizationHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer ([!-~]{16,256})$/u.exec(value);
  return match?.[1];
}

export function authorizationMatchesSessionToken(
  authorization: string | string[] | undefined,
  expected: string,
): boolean {
  const provided = bearerTokenFromAuthorizationHeader(authorization);
  if (provided === undefined) {
    sessionServerTokensMatch('', expected);
    return false;
  }
  return sessionServerTokensMatch(provided, expected);
}

/** Write the bearer token for the operator. The file mode excludes group and other on POSIX. */
export async function writeSessionServerTokenFile(dataDir: string, token: string): Promise<string> {
  assertSessionServerToken(token);
  const directory = path.join(dataDir, 'run');
  const filePath = path.join(directory, SESSION_SERVER_TOKEN_FILE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
    await chmod(filePath, 0o600);
  }
  return filePath;
}

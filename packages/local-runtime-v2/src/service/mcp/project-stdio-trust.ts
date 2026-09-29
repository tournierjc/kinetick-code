import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readProjectMcpConfig } from './project-config.js';

export const PROJECT_STDIO_TRUST_FILE = 'mcp-project-trust.json';

interface ProjectStdioTrustFile {
  version: 1;
  workspaces: Record<string, string>;
}

function trustPath(dataDir: string): string {
  return path.join(dataDir, PROJECT_STDIO_TRUST_FILE);
}

async function readTrustFile(dataDir: string): Promise<ProjectStdioTrustFile> {
  try {
    const parsed = JSON.parse(await readFile(trustPath(dataDir), 'utf8')) as Partial<ProjectStdioTrustFile>;
    if (parsed.version !== 1 || !parsed.workspaces || typeof parsed.workspaces !== 'object') {
      return { version: 1, workspaces: {} };
    }
    const workspaces: Record<string, string> = {};
    for (const [root, digest] of Object.entries(parsed.workspaces)) {
      if (typeof digest === 'string' && digest.length > 0) workspaces[root] = digest;
    }
    return { version: 1, workspaces };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: {} };
    return { version: 1, workspaces: {} };
  }
}

/** True when this workspace's current `.mcp.json` digest was trusted from outside the repo. */
export async function isProjectStdioTrusted(
  dataDir: string,
  workspaceRoot: string,
  digest: string,
): Promise<boolean> {
  if (!digest || digest === 'missing' || digest === 'unreadable') return false;
  const file = await readTrustFile(dataDir);
  return file.workspaces[workspaceRoot] === digest;
}

/**
 * Record the current `.mcp.json` digest for `workspaceDir`.
 * A later edit changes the digest and requires this command again.
 */
export async function trustProjectStdioWorkspace(
  dataDir: string,
  workspaceDir: string,
): Promise<string> {
  const document = await readProjectMcpConfig(workspaceDir);
  if (document.digest === 'missing') {
    throw new Error(`No .mcp.json in ${document.root}.`);
  }
  if (document.error || document.digest === 'unreadable') {
    throw new Error(document.error ?? 'Cannot read .mcp.json.');
  }
  const current = await readTrustFile(dataDir);
  current.workspaces[document.root] = document.digest;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filePath = trustPath(dataDir);
  await writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
  return `Trusted stdio MCP commands for ${document.root}. Edit .mcp.json and run this command again before those commands can start.`;
}

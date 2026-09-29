import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isPathAllowed, pathInWorkingPath } from '../../../src/tools/fs-permission.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-symlink-boundary-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('filesystem permission symlink boundary', () => {
  it('does not treat a workspace symlink to an outside file as in-workspace', () => {
    const root = tempRoot();
    const workspace = path.join(root, 'workspace');
    const outside = mkdtempSync(path.join(homedir(), '.fs-symlink-boundary-'));
    roots.push(outside);
    mkdirSync(workspace);
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'secret');
    const link = path.join(workspace, 'looks-local.txt');
    symlinkSync(secret, link);

    expect(pathInWorkingPath(link, workspace)).toBe(false);
    const decision = isPathAllowed(link, [], { workingDirectory: workspace }, 'read');
    expect(decision.allowed).toBe(false);
  });

  it('follows a dangling symlink before the workspace check', () => {
    const root = tempRoot();
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const link = path.join(workspace, 'pending.txt');
    symlinkSync(path.join(outside, 'not-created.txt'), link);

    expect(pathInWorkingPath(link, workspace)).toBe(false);
    expect(isPathAllowed(link, [], { workingDirectory: workspace }, 'write').allowed).toBe(false);
  });

  it('still allows a real file inside the workspace', () => {
    const root = tempRoot();
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const file = path.join(workspace, 'notes.txt');
    writeFileSync(file, 'notes');

    expect(pathInWorkingPath(file, workspace)).toBe(true);
    expect(isPathAllowed(file, [], { workingDirectory: workspace }, 'read').allowed).toBe(true);
  });
});

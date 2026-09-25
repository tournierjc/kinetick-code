import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliBuildVersion, versionFromTag } from './lib/cli-release.mjs';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

export function assertGithubRepo(repo) {
  if (typeof repo !== 'string' || !repoPattern.test(repo)) throw new Error('GH_REPO must be owner/name.');
  return repo;
}

function apiDetail(error) {
  return `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`;
}

export function githubApi(gh, endpoint, { method = 'GET', input, allowNotFound = false } = {}) {
  const args = ['api', '--method', method, endpoint];
  if (input !== undefined) args.push('--input', '-');
  try {
    const stdout = gh(args, { encoding: 'utf8', input });
    if (typeof stdout !== 'string' || !stdout.trim()) throw new Error(`GitHub API ${method} ${endpoint} returned an empty response.`);
    return JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`GitHub API ${method} ${endpoint} returned invalid JSON.`);
    // Missing releases are 404; unknown refs on commits/<tag> are 422
    // ("No commit found for SHA"). Both mean the tag/release is absent.
    if (allowNotFound && /Not Found|No commit found|\b404\b|\b422\b/.test(apiDetail(error))) return null;
    throw error;
  }
}

export function readGithubRelease(gh, repo, tag) {
  assertGithubRepo(repo);
  versionFromTag(tag);
  const body = githubApi(gh, `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
  if (!body) return null;
  if (body.tag_name !== tag || typeof body.draft !== 'boolean') throw new Error(`GitHub returned an unexpected release for ${tag}.`);
  return { tagName: body.tag_name, draft: body.draft };
}

export function readGithubTagCommit(gh, repo, tag) {
  assertGithubRepo(repo);
  versionFromTag(tag);
  const body = githubApi(gh, `repos/${repo}/commits/${encodeURIComponent(tag)}`, { allowNotFound: true });
  if (!body) return null;
  if (typeof body.sha !== 'string' || !shaPattern.test(body.sha)) throw new Error(`GitHub returned an unexpected commit for ${tag}.`);
  return body.sha;
}

// A push to main publishes only when this package version has no GitHub
// release. An existing release — including one created earlier by a tag push —
// stops the run before the build. Tags are immutable: a tag that already
// names a different commit fails the run instead of being moved.
export function mainReleaseDecision({ tag, head, release, tagCommit }) {
  versionFromTag(tag);
  if (typeof head !== 'string' || !shaPattern.test(head)) throw new Error('HEAD must be a full commit SHA.');
  if (release?.draft) {
    return {
      publish: false,
      fail: true,
      reason: `GitHub release ${tag} is a draft. Leaving it untouched. Finish or remove that draft before retrying; this workflow does not delete releases.`,
    };
  }
  if (release) return { publish: false, reason: `GitHub release ${tag} is already published; not creating another.` };
  if (tagCommit != null && tagCommit !== head) {
    return {
      publish: false,
      fail: true,
      reason: `Tag ${tag} points at ${tagCommit}, not ${head}. Refusing to move an existing tag. Re-run publication for the tagged commit, or remove the unpublished tag before retrying.`,
    };
  }
  return {
    publish: true,
    reason: tagCommit == null
      ? `No GitHub release or tag for ${tag}; this main push will tag HEAD and publish after validation.`
      : `Tag ${tag} already points at HEAD and has no GitHub release; publishing after validation.`,
  };
}

export function decideMainCliRelease({ root, repo, head, gh }) {
  const version = cliBuildVersion(root, null);
  const tag = `v${version}`;
  const release = readGithubRelease(gh, repo, tag);
  const tagCommit = release ? null : readGithubTagCommit(gh, repo, tag);
  return { version, tag, head, ...mainReleaseDecision({ tag, head, release, tagCommit }) };
}

export function runMainReleaseGate({ root, repo, head, gh, outputPath }) {
  const decision = decideMainCliRelease({ root, repo, head, gh });
  if (outputPath) appendFileSync(outputPath, `publish=${decision.publish ? 'true' : 'false'}\n`);
  if (decision.fail) throw new Error(decision.reason);
  return decision;
}

function assertReleaseTarget({ tag, version, commit, repo }) {
  assertGithubRepo(repo);
  if (versionFromTag(tag) !== version) throw new Error('Release tag must match the package version.');
  if (typeof commit !== 'string' || !shaPattern.test(commit)) throw new Error('Release commit must be a full SHA.');
}

// Create the annotated tag only after install validation, and only when it is
// absent. The workflow token creates it, so GitHub does not start a second
// CLI release run for that tag push. An existing tag is never moved.
export function ensureAnnotatedReleaseTag({ tag, version, commit, repo, gh }) {
  assertReleaseTarget({ tag, version, commit, repo });
  const existing = readGithubTagCommit(gh, repo, tag);
  if (existing) {
    if (existing !== commit) throw new Error(`Tag ${tag} already points at ${existing}, not ${commit}. Refusing to move an existing tag. Re-run publication for the tagged commit, or remove the unpublished tag before retrying.`);
    return { created: false };
  }
  const tagObject = githubApi(gh, `repos/${repo}/git/tags`, {
    method: 'POST',
    input: JSON.stringify({ tag, message: `Kinetick Code ${version}\n`, object: commit, type: 'commit' }),
  });
  if (typeof tagObject.sha !== 'string' || !shaPattern.test(tagObject.sha)) throw new Error(`GitHub did not return a tag object for ${tag}.`);
  try {
    githubApi(gh, `repos/${repo}/git/refs`, {
      method: 'POST',
      input: JSON.stringify({ ref: `refs/tags/${tag}`, sha: tagObject.sha }),
    });
  } catch (error) {
    if (!/Reference already exists/.test(apiDetail(error))) throw error;
    const current = readGithubTagCommit(gh, repo, tag);
    if (current !== commit) throw new Error(`Tag ${tag} already points at ${current}, not ${commit}. Refusing to move an existing tag. Re-run publication for the tagged commit, or remove the unpublished tag before retrying.`);
    return { created: false };
  }
  return { created: true, tagObject: tagObject.sha };
}

export function prepareCliReleasePublication({ tag, version, commit, repo, gh }) {
  assertReleaseTarget({ tag, version, commit, repo });
  const release = readGithubRelease(gh, repo, tag);
  if (release?.draft) {
    throw new Error(`GitHub release ${tag} is a draft. Leaving it untouched. Finish or remove that draft before retrying; this workflow does not delete releases.`);
  }
  if (release) return { action: 'skip', reason: `GitHub release ${tag} is already published; leaving it untouched.` };
  return { action: 'create', ...ensureAnnotatedReleaseTag({ tag, version, commit, repo, gh }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
      throw new Error(`Checkout ${head} does not match GITHUB_SHA ${process.env.GITHUB_SHA}.`);
    }
    const decision = runMainReleaseGate({
      root,
      repo: process.env.GH_REPO,
      head,
      gh: (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', input: options.input, stdio: ['pipe', 'pipe', 'pipe'] }),
      outputPath: process.env.GITHUB_OUTPUT,
    });
    console.log(decision.reason);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

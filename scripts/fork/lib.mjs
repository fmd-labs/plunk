// Shared helpers for the fork maintenance scripts in scripts/fork/.
//
// These scripts have no dependencies on purpose: they run in CI before `yarn install`
// and must keep working when upstream changes the toolchain.

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

export const UPSTREAM_URL = 'https://github.com/useplunk/plunk.git';
export const UPSTREAM_BRANCH = 'next';
export const UPSTREAM_TRACKING_REF = 'refs/fork-audit/upstream-next';

export function git(args, options = {}) {
  return execFileSync('git', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options}).trim();
}

function lines(output) {
  return output === '' ? [] : output.split('\n');
}

/**
 * Resolve the upstream commit to compare against.
 *
 * `FORK_AUDIT_UPSTREAM_REF` (for example `upstream/next` in a local clone) wins; otherwise the
 * upstream branch is fetched into a private ref so no remote configuration is needed (CI).
 */
export function resolveUpstreamRef() {
  const configured = process.env.FORK_AUDIT_UPSTREAM_REF;
  if (configured) {
    return configured;
  }

  git(['fetch', '--no-tags', '--quiet', UPSTREAM_URL, `+${UPSTREAM_BRANCH}:${UPSTREAM_TRACKING_REF}`]);
  return UPSTREAM_TRACKING_REF;
}

/**
 * Files that differ between the fork and its merge base with upstream.
 *
 * The merge base is the last upstream commit merged into the fork, so the diff contains only
 * the fork's own changes, however far upstream has moved on since. Renames are split into a
 * deletion and an addition so both paths have to be accounted for.
 */
export function changedFiles({upstreamRef, workingTree = false, addedOnly = false}) {
  const base = git(['merge-base', 'HEAD', upstreamRef]);
  const filter = addedOnly ? ['--diff-filter=A'] : [];
  const tracked = workingTree
    ? lines(git(['diff', '--name-only', '--no-renames', ...filter, base]))
    : lines(git(['diff', '--name-only', '--no-renames', ...filter, base, 'HEAD']));
  const untracked = workingTree ? lines(git(['ls-files', '--others', '--exclude-standard'])) : [];

  return {base, files: [...new Set([...tracked, ...untracked])].sort()};
}

/**
 * Parse the machine-checked parts of FORK.md (see its "Format" section).
 *
 * - Each divergence is a `### Dnn — title` section. Its `- **Files:**` bullet is followed by
 *   nested bullets holding one backticked path each: an exact path, or a directory prefix
 *   ending in `/`.
 * - The "Workflow inventory" table lists every workflow file present in the fork, one
 *   backticked file name in the first column of each row.
 */
export function parseForkLog(path = 'FORK.md') {
  const text = readFileSync(path, 'utf8');
  const divergences = [];
  const workflows = [];
  let divergence = null;
  let inFiles = false;
  let inWorkflowInventory = false;

  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const id = /^(D\d{2,})\b/.exec(heading[2])?.[1];
      divergence = heading[1] === '###' && id ? {id, entries: []} : null;
      if (divergence) {
        divergences.push(divergence);
      }
      inFiles = false;
      inWorkflowInventory = /^Workflow inventory$/i.test(heading[2]);
      continue;
    }

    if (divergence) {
      if (/^- \*\*Files:\*\*\s*$/.test(line)) {
        inFiles = true;
        continue;
      }
      const entry = /^\s+- `([^`]+)`\s*$/.exec(line);
      if (inFiles && entry) {
        divergence.entries.push(entry[1]);
        continue;
      }
      inFiles = false;
      continue;
    }

    if (inWorkflowInventory && line.trim().startsWith('|')) {
      const firstCell = line.trim().replace(/^\|/, '').split('|')[0] ?? '';
      const name = /`([^`]+)`/.exec(firstCell)?.[1];
      if (name) {
        workflows.push(name);
      }
    }
  }

  return {divergences, workflows};
}

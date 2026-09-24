// Shared helpers for the fork maintenance scripts in scripts/fork/.
//
// These scripts have no dependencies on purpose: they run in CI before `yarn install`
// and must keep working when upstream changes the toolchain.

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const UPSTREAM_URL = 'https://github.com/useplunk/plunk.git';
export const UPSTREAM_BRANCH = 'next';
export const UPSTREAM_TRACKING_REF = 'refs/fork-audit/upstream-next';

/** The checkout these scripts belong to. Paths are relative to it, wherever the scripts run from. */
export const repoRoot = resolve(import.meta.dirname, '..', '..');

export function git(args, options = {}) {
  // Paths passed to git are file names, never pathspec patterns.
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

/** Split NUL-separated (`-z`) git output, which never quotes or escapes paths. */
function paths(output) {
  return output.split('\0').filter(path => path !== '');
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
export function changedFiles({upstreamRef, workingTree = false}) {
  const base = git(['merge-base', 'HEAD', upstreamRef]);
  const range = workingTree ? [base] : [base, 'HEAD'];
  const tracked = paths(git(['diff', '-z', '--name-only', '--no-renames', ...range]));
  const untracked = workingTree ? paths(git(['ls-files', '-z', '--others', '--exclude-standard'])) : [];

  return {base, files: [...new Set([...tracked, ...untracked])].sort()};
}

/** Whether `path` (a file or a directory) exists at `ref`. */
export function existsAt(ref, path) {
  return git(['ls-tree', '--name-only', ref, '--', path.replace(/\/+$/, '')]) !== '';
}

/**
 * Parse the machine-checked parts of FORK.md (see its "Format" section).
 *
 * - Each divergence is a `### Dnn — title` section. Its `- **Files:**` bullet is followed by
 *   nested bullets holding one backticked path each: an exact path, or a directory prefix
 *   ending in `/`.
 * - The "Workflow inventory" table lists every workflow file present in the fork: a backticked
 *   file name in the first column and its state (`enabled` or `disabled`) in the third.
 *
 * HTML comments and fenced code blocks are skipped: they document, they never declare.
 */
export function parseForkLog(path = join(repoRoot, 'FORK.md')) {
  const text = readFileSync(path, 'utf8')
    // A comment on lines of its own goes with its line breaks, so it cannot split a list; an
    // unterminated one hides the rest of the file, as it does when GitHub renders it.
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(\r?\n|$)/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '');
  const divergences = [];
  const workflows = [];
  let divergence = null;
  let inFiles = false;
  let inWorkflowInventory = false;
  // The open code fence: its character and length. Only a fence of the same character, at least as
  // long and without an info string, closes it (CommonMark).
  let fence = null;

  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') {
        fence = null;
      }
      continue;
    }
    // A backtick fence's info string cannot contain backticks; such a line is inline code.
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = {char: marker[1][0], length: marker[1].length};
      continue;
    }

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
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(cell => cell.trim());
      const name = /`([^`]+)`/.exec(cells[0] ?? '')?.[1];
      if (name) {
        workflows.push({name, state: cells[2] ?? ''});
      }
    }
  }

  return {divergences, workflows};
}

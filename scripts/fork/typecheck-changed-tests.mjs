#!/usr/bin/env node
// Type-check the fork's test code.
//
// Upstream excludes tests from every tsconfig and Vitest strips types without checking them, so
// type errors in tests surface nowhere. Upstream's own tests do not type-check cleanly, so this
// reports errors only in test code the fork wrote: every line of a test file the fork adds, and
// the lines the fork adds to an upstream test file. An error that fork code causes on an unchanged
// upstream line is not reported. Resolution follows Vitest (bundler-style imports, the `@plunk/*`
// aliases to package sources, Vitest globals), not the NodeNext build config.
//
// Usage:
//   node scripts/fork/typecheck-changed-tests.mjs                   # the fork's test code at HEAD
//   node scripts/fork/typecheck-changed-tests.mjs --working-tree    # include uncommitted/untracked
//   node scripts/fork/typecheck-changed-tests.mjs --files a.ts b.ts # every line of these files
//
// Requires installed dependencies and a generated Prisma client.

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';

import {changedFiles, existsAt, git, repoRoot, resolveUpstreamRef} from './lib.mjs';

// The aliases in vitest.config.ts, so tests type-check against the sources Vitest runs.
const PACKAGE_ALIASES = {
  '@plunk/db': 'packages/db/src',
  '@plunk/shared': 'packages/shared/src',
  '@plunk/types': 'packages/types/src',
  '@plunk/email': 'packages/email/src',
};

const argv = process.argv.slice(2);
const filesFlag = argv.indexOf('--files');
const workingTree = argv.includes('--working-tree');

/** Repository-relative POSIX path of `file`, resolved from `from`. */
const toRepoPath = (file, from = process.cwd()) => relative(repoRoot, resolve(from, file)).split(sep).join('/');

const isTestFile = file =>
  /\.(ts|tsx)$/.test(file) &&
  (/(^|\/)__tests__\//.test(file) || file.startsWith('test/')) &&
  existsSync(join(repoRoot, file));

/**
 * Line numbers `file` has that its merge-base version does not (the new side of each hunk), or
 * `null` to check the whole file when git's line numbers may not match TypeScript's: TypeScript
 * also breaks lines at U+2028, U+2029 and a lone carriage return.
 */
function addedLines(base, file) {
  if (/[\u2028\u2029]|\r(?!\n)/.test(readFileSync(join(repoRoot, file), 'utf8'))) {
    return null;
  }

  const diff = git([
    'diff',
    '-U0',
    // Plain hunks whatever the local git configuration says: no external diff tool or textconv,
    // and no merging of nearby hunks, which would count unchanged lines between them as added.
    '--no-ext-diff',
    '--no-textconv',
    '--inter-hunk-context=0',
    '--no-renames',
    '--no-color',
    ...(workingTree ? [base] : [base, 'HEAD']),
    '--',
    file,
  ]);
  const lines = new Set();
  for (const [, start, count = '1'] of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let line = Number(start); line < Number(start) + Number(count); line++) {
      lines.add(line);
    }
  }
  return lines;
}

// The lines to report errors on, per file; `null` means every line.
const targets = new Map();
if (filesFlag !== -1) {
  for (const file of argv.slice(filesFlag + 1).map(file => toRepoPath(file))) {
    if (!isTestFile(file)) {
      console.error(`${file}: not an existing test file (__tests__/ or test/, .ts or .tsx)`);
      process.exit(1);
    }
    targets.set(file, null);
  }
} else {
  const {base, files} = changedFiles({upstreamRef: resolveUpstreamRef(), workingTree});
  for (const file of files.filter(isTestFile)) {
    // tsc reads the working tree, so committed line numbers only hold for a clean file.
    if (!workingTree && git(['status', '--porcelain', '--', file]) !== '') {
      console.error(`${file}: has uncommitted changes; commit them or run with --working-tree`);
      process.exit(1);
    }
    const lines = existsAt(base, file) ? addedLines(base, file) : null;
    if (lines === null || lines.size > 0) {
      targets.set(file, lines);
    }
  }
}

if (targets.size === 0) {
  console.log('No fork test code to type-check.');
  process.exit(0);
}

const cacheDir = join(repoRoot, 'node_modules', '.cache', 'fork-typecheck');
mkdirSync(cacheDir, {recursive: true});

// tsc skips type checking altogether when it meets an option error or a syntax error anywhere in
// the program, and reports only that error, which may sit in a file this check filters out. The
// canary's one known type error proves that checking ran.
const canaryPath = join(cacheDir, 'canary.ts');
writeFileSync(canaryPath, "export const canary: number = 'not a number';\n");
const canary = toRepoPath(canaryPath, repoRoot);

const tsconfigPath = join(cacheDir, 'tsconfig.json');
writeFileSync(
  tsconfigPath,
  JSON.stringify(
    {
      extends: join(repoRoot, 'packages', 'typescript-config', 'base.json'),
      compilerOptions: {
        noEmit: true,
        declaration: false,
        declarationMap: false,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        allowImportingTsExtensions: true,
        rootDir: repoRoot,
        jsx: 'react-jsx',
        types: ['node', 'vitest/globals'],
        paths: Object.fromEntries(
          Object.entries(PACKAGE_ALIASES).flatMap(([alias, source]) => [
            [alias, [join(repoRoot, source)]],
            [`${alias}/*`, [join(repoRoot, source, '*')]],
          ]),
        ),
      },
      files: [...targets.keys()].map(file => join(repoRoot, file)).concat(canaryPath),
    },
    null,
    2,
  ),
);

console.log(`Type-checking fork test code in ${targets.size} file(s):`);
for (const [file, lines] of targets) {
  console.log(`  - ${file} (${lines === null ? 'whole file' : `${lines.size} added line(s)`})`);
}

const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
const result = spawnSync(tsc, ['--project', tsconfigPath, '--pretty', 'false'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${result.stdout}${result.stderr}`;

if (result.error) {
  throw result.error;
}
// tsc exits 1 or 2 when it reports errors, which it always does here (the canary); anything else
// means it did not run.
if (result.signal || ![1, 2].includes(result.status)) {
  console.error(output);
  console.error(
    `tsc did not complete (${result.signal ? `signal ${result.signal}` : `exit status ${result.status}`}).`,
  );
  process.exit(1);
}

// A diagnostic starts with `path(line,col): error` and may continue on indented lines. Keep those
// on the targeted lines; imported upstream code (test helpers, fixtures) is not type-clean upstream
// and is not this check's concern. Errors outside TypeScript files (the generated tsconfig) and
// errors without a location are never filtered.
const diagnostics = [];
let canaryReported = false;
let current = null;
for (const line of output.split('\n')) {
  const match = /^(.+?)\((\d+),\d+\): error /.exec(line);
  if (match) {
    const file = toRepoPath(match[1], repoRoot);
    const lines = targets.get(file);
    if (file === canary) {
      canaryReported = true;
      current = null;
      continue;
    }
    const report = !/\.[cm]?tsx?$/.test(file) || (targets.has(file) && (lines === null || lines.has(Number(match[2]))));
    current = report ? [line] : null;
    if (current) {
      diagnostics.push(current);
    }
  } else if (current && /^\s+\S/.test(line)) {
    current.push(line);
  } else if (line.trim() !== '' && !/^\s/.test(line)) {
    diagnostics.push([line]);
    current = null;
  }
}

if (!canaryReported) {
  console.error(output);
  console.error('tsc reported no error for the canary file, so it did not type-check the program (see above).');
  process.exit(1);
}

if (diagnostics.length > 0) {
  console.error(diagnostics.map(block => block.join('\n')).join('\n'));
  console.error(`\n${diagnostics.length} error(s) in the fork's test code or the check's setup.`);
  process.exit(1);
}

console.log('Fork test code type-checks cleanly.');

#!/usr/bin/env node
// Type-check the test files this fork adds.
//
// Upstream excludes tests from every tsconfig and Vitest strips types without checking them, so
// type errors in tests surface nowhere. Upstream's own tests do not type-check cleanly, so this
// checks only test files the fork adds (fork tests live in their own files). Resolution follows
// Vitest (bundler-style: extensionless and directory imports), not the NodeNext build config.
//
// Usage:
//   node scripts/fork/typecheck-changed-tests.mjs                  # test files added at HEAD
//   node scripts/fork/typecheck-changed-tests.mjs --working-tree   # include uncommitted/untracked
//   node scripts/fork/typecheck-changed-tests.mjs --files a.ts b.ts
//
// Requires installed dependencies and built workspace packages (tests import them from dist).

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {changedFiles, resolveUpstreamRef} from './lib.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const filesFlag = argv.indexOf('--files');

const isTestFile = file =>
  /\.(ts|tsx)$/.test(file) && (/(^|\/)__tests__\//.test(file) || file.startsWith('test/')) && existsSync(file);

let candidates;
if (filesFlag !== -1) {
  candidates = argv.slice(filesFlag + 1);
} else {
  const upstreamRef = resolveUpstreamRef();
  candidates = changedFiles({upstreamRef, workingTree: argv.includes('--working-tree'), addedOnly: true}).files;
}

const testFiles = candidates.filter(isTestFile);
if (testFiles.length === 0) {
  console.log('No test files added by the fork; nothing to type-check.');
  process.exit(0);
}

const cacheDir = join(repoRoot, 'node_modules', '.cache', 'fork-typecheck');
mkdirSync(cacheDir, {recursive: true});
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
        rootDir: repoRoot,
        jsx: 'react-jsx',
        types: ['node'],
      },
      files: testFiles.map(file => join(repoRoot, file)),
    },
    null,
    2,
  ),
);

console.log(`Type-checking ${testFiles.length} test file(s):`);
for (const file of testFiles) {
  console.log(`  - ${file}`);
}

const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
const result = spawnSync(tsc, ['--project', tsconfigPath, '--pretty', 'false'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) {
  throw result.error;
}

// Keep only diagnostics located in the checked files. Imported upstream code (test helpers,
// fixtures) is not type-clean upstream and is not this check's concern. A diagnostic starts with
// `path(line,col): error` and may continue on indented lines.
const targets = new Set(testFiles);
const diagnostics = [];
let current = null;
for (const line of `${result.stdout}${result.stderr}`.split('\n')) {
  const match = /^(.+?)\(\d+,\d+\): error /.exec(line);
  if (match) {
    current = targets.has(match[1]) ? [line] : null;
    if (current) {
      diagnostics.push(current);
    }
  } else if (current && /^\s+\S/.test(line)) {
    current.push(line);
  } else if (!match && line.trim() !== '' && !/^\s/.test(line)) {
    // Global errors (bad config, missing files) are never filtered.
    diagnostics.push([line]);
    current = null;
  }
}

if (diagnostics.length > 0) {
  console.error(diagnostics.map(block => block.join('\n')).join('\n'));
  console.error(`\n${diagnostics.length} type error(s) in fork test files.`);
  process.exit(1);
}

console.log('Fork test files type-check cleanly.');

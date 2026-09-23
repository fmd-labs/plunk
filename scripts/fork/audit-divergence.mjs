#!/usr/bin/env node
// Verify that FORK.md accounts for every difference between this fork and upstream.
//
// Usage:
//   node scripts/fork/audit-divergence.mjs                 # committed state (HEAD), as in CI
//   node scripts/fork/audit-divergence.mjs --working-tree  # include uncommitted and untracked files
//   node scripts/fork/audit-divergence.mjs --list          # print the differing files and exit
//
// Set FORK_AUDIT_UPSTREAM_REF (for example `upstream/next`) to compare against a local ref instead
// of fetching upstream.

import {readdirSync} from 'node:fs';

import {changedFiles, git, parseForkLog, resolveUpstreamRef} from './lib.mjs';

const WORKFLOW_DIR = '.github/workflows/';
const SCHEMA_DIR = 'packages/db/prisma/';

const args = new Set(process.argv.slice(2));
const upstreamRef = resolveUpstreamRef();
const {base, files} = changedFiles({upstreamRef, workingTree: args.has('--working-tree')});

if (args.has('--list')) {
  process.stdout.write(`${files.join('\n')}\n`);
  process.exit(0);
}

const {divergences, workflows} = parseForkLog();
const failures = [];

const entries = divergences.flatMap(divergence => divergence.entries.map(entry => ({divergence, entry})));
const covers = (entry, file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry);

// 1. Every differing file is listed under a divergence.
for (const file of files) {
  if (!entries.some(({entry}) => covers(entry, file))) {
    failures.push(`${file}: differs from upstream but is not listed in FORK.md`);
  }
}

// 2. Every listed path still differs; stale entries mean FORK.md no longer matches the code.
for (const {divergence, entry} of entries) {
  if (!files.some(file => covers(entry, file))) {
    failures.push(`${entry}: listed under ${divergence.id} but identical to upstream (remove or fix the entry)`);
  }
}

// 3. The fork never changes the database schema, so its images stay interchangeable with upstream.
for (const file of files.filter(file => file.startsWith(SCHEMA_DIR))) {
  failures.push(`${file}: the fork must not change ${SCHEMA_DIR} (no Prisma migrations or schema edits)`);
}

// 4. Every workflow file is inventoried: upstream syncs can add workflows that would run here.
const workflowFiles = readdirSync(WORKFLOW_DIR).filter(name => /\.ya?ml$/.test(name));
for (const name of workflowFiles.filter(name => !workflows.includes(name))) {
  failures.push(`${WORKFLOW_DIR}${name}: missing from the "Workflow inventory" in FORK.md`);
}
for (const name of workflows.filter(name => !workflowFiles.includes(name))) {
  failures.push(`${name}: listed in the "Workflow inventory" but not present in ${WORKFLOW_DIR}`);
}

const ids = divergences.map(divergence => divergence.id);
for (const id of ids.filter((id, index) => ids.indexOf(id) !== index)) {
  failures.push(`${id}: divergence ID used more than once`);
}
for (const divergence of divergences.filter(divergence => divergence.entries.length === 0)) {
  failures.push(`${divergence.id}: no **Files:** entries (see the Format section of FORK.md)`);
}

const baseSummary = git(['log', '-1', '--format=%h %s', base]);
console.log(`Upstream merge base: ${baseSummary}`);
console.log(`Files differing from upstream: ${files.length}; divergences listed: ${divergences.length}`);

if (failures.length > 0) {
  console.error(`\nFORK.md is out of date (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('FORK.md accounts for every difference from upstream.');

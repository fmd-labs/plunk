#!/usr/bin/env node
// Verify that FORK.md accounts for every difference between this fork and upstream.
//
// Usage:
//   node scripts/fork/audit-divergence.mjs                 # committed state (HEAD), as in CI
//   node scripts/fork/audit-divergence.mjs --working-tree  # include uncommitted and untracked files
//   node scripts/fork/audit-divergence.mjs --list          # print the differing files and exit
//
// Set FORK_AUDIT_UPSTREAM_REF (for example `upstream/next`) to compare against a local ref instead
// of fetching upstream. With GITHUB_TOKEN and GITHUB_REPOSITORY set (CI), the workflow inventory's
// states are also compared with the repository's Actions settings.

import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {changedFiles, existsAt, git, parseForkLog, repoRoot, resolveUpstreamRef} from './lib.mjs';

const WORKFLOW_DIR = '.github/workflows/';
const SCHEMA_DIR = 'packages/db/prisma/';
const WORKFLOW_STATES = ['enabled', 'disabled'];

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

// 3. A directory entry covers everything below it, so it may only name a directory the fork adds.
//    Changes inside upstream directories are listed file by file.
for (const {divergence, entry} of entries.filter(({entry}) => entry.endsWith('/'))) {
  if (existsAt(base, entry)) {
    failures.push(
      `${entry}: listed under ${divergence.id} as a directory, but upstream has it; list the files instead`,
    );
  }
}

// 4. The fork never changes the database schema, so its images stay interchangeable with upstream.
for (const file of files.filter(file => file.startsWith(SCHEMA_DIR))) {
  failures.push(`${file}: the fork must not change ${SCHEMA_DIR} (no Prisma migrations or schema edits)`);
}

// 5. Every workflow file is inventoried: upstream syncs can add workflows that would run here.
const inventory = new Map(workflows.map(workflow => [workflow.name, workflow.state]));
const workflowFiles = readdirSync(join(repoRoot, WORKFLOW_DIR)).filter(name => /\.ya?ml$/.test(name));
for (const name of workflowFiles.filter(name => !inventory.has(name))) {
  failures.push(`${WORKFLOW_DIR}${name}: missing from the "Workflow inventory" in FORK.md`);
}
for (const [name, state] of inventory) {
  if (!workflowFiles.includes(name)) {
    failures.push(`${name}: listed in the "Workflow inventory" but not present in ${WORKFLOW_DIR}`);
  }
  if (!WORKFLOW_STATES.includes(state)) {
    failures.push(`${name}: state "${state}" in the "Workflow inventory" must be one of ${WORKFLOW_STATES.join(', ')}`);
  }
}

// 6. The recorded states match the repository's Actions settings, which live outside the code.
const notes = [];
const {GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = 'https://api.github.com'} = process.env;
if (GITHUB_TOKEN && GITHUB_REPOSITORY) {
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows?per_page=100`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`Listing workflows failed: HTTP ${response.status} ${await response.text()}`);
  }
  const registered = (await response.json()).workflows;
  for (const [name, state] of inventory) {
    const workflow = registered.find(candidate => candidate.path === `${WORKFLOW_DIR}${name}`);
    if (!workflow) {
      // Actions registers a workflow once it reaches the default branch.
      notes.push(`${name}: not registered in Actions yet; its state is checked once it is on the default branch`);
    } else if ((workflow.state === 'active') !== (state === 'enabled')) {
      failures.push(`${name}: recorded as ${state}, but its state in Actions is "${workflow.state}"`);
    }
  }
} else {
  notes.push('Workflow states not compared with Actions (needs GITHUB_TOKEN and GITHUB_REPOSITORY, as in CI).');
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
for (const note of notes) {
  console.log(`Note: ${note}`);
}

if (failures.length > 0) {
  console.error(`\nFORK.md is out of date (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('FORK.md accounts for every difference from upstream.');

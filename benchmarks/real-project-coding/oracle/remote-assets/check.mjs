#!/usr/bin/env node
// Mechanical submission/source validation only. Prose correctness requires a human.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { run } from 'node:test';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function finish(exitCode, status, errors, assertions = 0) {
  console.log(JSON.stringify({
    case_id: 'BRPCB-A',
    status,
    functional_success: exitCode === 2 || status === 'needs_human_review' ? null : false,
    assertions,
    errors,
    semantic_review: 'not_performed',
  }));
  process.exit(exitCode);
}

if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) {
  finish(2, 'setup_failure', ['Usage: node oracle/remote-assets/check.mjs /absolute/candidate/workspace']);
}
if (Number(process.versions.node.split('.')[0]) !== 24) {
  finish(2, 'environment_failure', ['This frozen extraction requires Node 24 native TypeScript support.']);
}

let candidate;
try {
  candidate = realpathSync(process.argv[2]);
  if (!statSync(candidate).isDirectory()) throw new Error('Candidate must be a directory.');
} catch (error) {
  finish(2, 'setup_failure', [`Invalid candidate directory: ${error.message}`]);
}

try {
  const answerPath = join(candidate, 'ANSWER.md');
  if (!lstatSync(answerPath).isFile()) throw new Error('ANSWER.md must be a regular file, not a symlink or directory.');
  const answer = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(answerPath));
  if (!answer.trim()) throw new Error('ANSWER.md must contain a nonempty explanation.');
  if (answer.includes('\0')) throw new Error('ANSWER.md must be a UTF-8 text explanation, without NUL bytes.');
} catch (error) {
  finish(1, 'fail', [`Missing or invalid submission: ${error.message}`]);
}

const canonicalProbes = fileURLToPath(new URL('../../workspaces/remote-assets/tests/public.test.mjs', import.meta.url));
const previousWorkspace = process.env.BRPCB_REMOTE_ASSETS_WORKSPACE;
process.env.BRPCB_REMOTE_ASSETS_WORKSPACE = candidate;
let passed = 0;
let failed = 0;
const probeErrors = [];
try {
  // In-process Node test events avoid requiring permission to spawn a nested
  // process. This is source verification, not a sandbox/isolation boundary.
  const probes = run({ files: [canonicalProbes], isolation: 'none', concurrency: false, timeout: 15000 });
  for await (const event of probes) {
    if (event.type === 'test:pass') {
      if (event.data.skip || event.data.todo) probeErrors.push(`Probe did not execute: ${event.data.name}`);
      else passed += 1;
    }
    if (event.type === 'test:fail') {
      failed += 1;
      probeErrors.push(`${event.data.name}: ${event.data.details?.error?.message ?? 'probe failed'}`);
    }
  }
} catch (error) {
  probeErrors.push(error.message);
} finally {
  if (previousWorkspace === undefined) delete process.env.BRPCB_REMOTE_ASSETS_WORKSPACE;
  else process.env.BRPCB_REMOTE_ASSETS_WORKSPACE = previousWorkspace;
}
const assertions = passed + failed;
if (passed !== 17 || failed !== 0 || probeErrors.length) {
  finish(1, 'fail', ['Canonical source probes did not complete with all 17 probes passing.', ...probeErrors], assertions);
}

// NEVER infer prose correctness from test results, keywords, similarity, or a
// nonempty answer. This script deliberately has no exit-0/semantic-pass branch.
finish(3, 'needs_human_review', [], assertions);

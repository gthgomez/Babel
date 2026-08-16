/**
 * convergence-parser.regression-gate.test.ts — RED baseline for the one-decoder.
 *
 * These tests encode the P0-2 invariants the converged tokenizer + parser must
 * satisfy. They run against the as-transplanted baseline (gitCommand.ts from
 * #86, commandSemantics.ts from #87) and are expected to FAIL for the
 * enumerated gaps — that failure is the demonstration of the defect. The fix
 * phase (one quote-aware tokenizer feeding structured ActionRequests) turns
 * them green.
 *
 * Each test names the invariant, not the implementation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGitCommand } from './gitCommand.js';
import { classifyCommandSemantics } from '../agent/commandSemantics.js';

// ─── git option-argument consumption ───────────────────────────────────────

test('P0-2: git -C <path> consumes its argument; the verb is resolved', () => {
  const p = parseGitCommand('git -C /tmp/repo push origin main');
  // Today: the skip loop leaves verb = '/tmp/repo' → unknown/ambiguous.
  assert.equal(p.capability, 'push_feature_branch');
  assert.equal(p.force, false);
});

test('P0-2: git -c <key=value> consumes its argument; the verb is resolved', () => {
  const p = parseGitCommand('git -c alias.st=status status');
  // Today: verb = 'alias.st=status' → unknown/ambiguous.
  assert.equal(p.capability, 'inspect_repository');
});

// ─── Git force semantics ───────────────────────────────────────────────────

test('P0-2: +refspec force form is equivalent to --force', () => {
  const p = parseGitCommand('git push origin +HEAD:refs/heads/feature');
  // Today: hasForce only sees --force/-f/--force-with-lease → force:false, push_feature_branch.
  assert.equal(p.force, true);
  assert.equal(p.capability, 'force_push');
});

test('P0-2: --mirror push is a forced high-impact form', () => {
  const p = parseGitCommand('git push --mirror origin');
  // Today: --mirror not recognized → force:false, push_feature_branch.
  assert.equal(p.force, true);
});

// ─── Quote-aware chain splitting ───────────────────────────────────────────

test('P0-2: semicolon inside quotes is not a command boundary (python -c)', () => {
  const c = classifyCommandSemantics(`python -c "x=1; print(open('.env').read())"`);
  // Today: split at the quoted ';' separates the interpreter from the .env reference.
  assert.equal(c, 'credential_access');
});

test('P0-2: && inside quotes is not a command boundary (sh -c with rg)', () => {
  const c = classifyCommandSemantics(`sh -c "echo ok && rg . .env"`);
  // Today: split at the quoted '&&' leaves 'rg . .env"' as its own segment, which
  // no credential-read verb matches.
  assert.equal(c, 'credential_access');
});

// ─── PowerShell forms ──────────────────────────────────────────────────────

test('P0-2: PowerShell -Command invocation-block form is unwrapped', () => {
  const c = classifyCommandSemantics(`powershell -Command "& { Get-Content .env }"`);
  // Today: unwrap yields '& { Get-Content .env }' → base '&' → unrecognized.
  assert.equal(c, 'credential_access');
});

// ─── Credential-read verbs ─────────────────────────────────────────────────

test('P0-2: rg credential read is recognized', () => {
  // Today: rg is not in CREDENTIAL_DUMP_TOOLS → unrecognized (not denied).
  assert.equal(classifyCommandSemantics('rg . .env'), 'credential_access');
});

test('P0-2: Select-String credential read is recognized', () => {
  assert.equal(classifyCommandSemantics('Select-String -Path .env -Pattern secret'), 'credential_access');
});

test('P0-2: grep credential read is recognized', () => {
  assert.equal(classifyCommandSemantics('grep -r TOKEN .env'), 'credential_access');
});

// ─── gh api method forms ───────────────────────────────────────────────────

test('P0-2: gh api --method=POST on a privileged endpoint is repo_admin', () => {
  const p = parseGitCommand('gh api --method=POST repos/foo/bar/releases');
  // Today: '--method=POST' is one token → method detection defaults to GET → pr_inspect.
  assert.equal(p.capability, 'repo_admin');
});

test('P0-2: gh api -X POST on a privileged endpoint is repo_admin (guard)', () => {
  const p = parseGitCommand('gh api -X POST repos/foo/bar/releases');
  // Guard: the separate-token form is already handled correctly — must not regress.
  assert.equal(p.capability, 'repo_admin');
});

// ─── SQL behind DB clients ─────────────────────────────────────────────────

test('P0-2: psql -c "DROP TABLE" is destructive_data_delete (guard)', () => {
  const p = parseGitCommand('psql mydb -c "DROP TABLE users"');
  // Guard: #86's DANGEROUS_TOOL_PATTERNS text scan already catches embedded SQL —
  // the merged parser must keep this.
  assert.equal(p.capability, 'destructive_data_delete');
});

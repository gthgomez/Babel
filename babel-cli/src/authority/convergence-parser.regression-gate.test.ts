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
import { classifyCommandSemantics, splitChains } from '../agent/commandSemantics.js';

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

// ─── Git global options that consume a following token (L14–L17) ───────────

test('L14 P0-2: git --git-dir <path> push — the path belongs to the option', () => {
  const p = parseGitCommand('git --git-dir /repo push origin main');
  assert.equal(p.capability, 'push_feature_branch');
  assert.equal(p.force, false);
});

test('L15 P0-2: git --work-tree <path> push — the path belongs to the option', () => {
  const p = parseGitCommand('git --work-tree /repo push origin main');
  assert.equal(p.capability, 'push_feature_branch');
});

test('L16 P0-2: git --namespace <name> push — the name belongs to the option', () => {
  const p = parseGitCommand('git --namespace foo push origin main');
  assert.equal(p.capability, 'push_feature_branch');
});

test('L17 P0-2: git --config-env <key=ENV> push — the assignment belongs to the option', () => {
  const p = parseGitCommand('git --config-env user.name=MY_NAME push origin main');
  assert.equal(p.capability, 'push_feature_branch');
});

// ─── Git force / refspec family (L18–L23) ──────────────────────────────────

test('L18 P0-2: git push -f is force_push (guard)', () => {
  const p = parseGitCommand('git push -f origin feature');
  assert.equal(p.capability, 'force_push');
  assert.equal(p.force, true);
});

test('L19 P0-2: git push --force is force_push (guard)', () => {
  const p = parseGitCommand('git push --force origin feature');
  assert.equal(p.capability, 'force_push');
  assert.equal(p.force, true);
});

test('L20 P0-2: git push --force-with-lease is force_push (guard)', () => {
  const p = parseGitCommand('git push --force-with-lease origin feature');
  assert.equal(p.capability, 'force_push');
  assert.equal(p.force, true);
});

test('L21 P0-2: git push origin +HEAD:refs/heads/x is force_push', () => {
  const p = parseGitCommand('git push origin +HEAD:refs/heads/x');
  assert.equal(p.capability, 'force_push');
  assert.equal(p.force, true);
});

test('L22 P0-2: git push origin :refs/heads/x is a delete (guard)', () => {
  const p = parseGitCommand('git push origin :refs/heads/x');
  assert.equal(p.capability, 'scope_expansion');
  assert.equal(p.delete, true);
});

test('L23 P0-2: git push --delete origin x is a delete (guard)', () => {
  const p = parseGitCommand('git push --delete origin x');
  assert.equal(p.delete, true);
});

// ─── gh api method forms (L24–L28) ─────────────────────────────────────────

test('L24 P0-2: gh api --method POST privileged endpoint is repo_admin (guard)', () => {
  const p = parseGitCommand('gh api --method POST repos/foo/bar/releases');
  assert.equal(p.capability, 'repo_admin');
});

test('L25 P0-2: gh api -X POST privileged endpoint is repo_admin (guard)', () => {
  const p = parseGitCommand('gh api -X POST repos/foo/bar/releases');
  assert.equal(p.capability, 'repo_admin');
});

test('L26 P0-2: gh api -XPOST attached form is repo_admin', () => {
  const p = parseGitCommand('gh api -XPOST repos/foo/bar/releases');
  assert.equal(p.capability, 'repo_admin');
});

test('L27 P0-2: gh api method after the endpoint is still found', () => {
  const p = parseGitCommand('gh api repos/foo/bar/releases --method=POST');
  assert.equal(p.capability, 'repo_admin');
});

// ─── Safe controls — recognized safe engineering must stay frictionless ────

test('L28 P0-2: gh api GET stays pr_inspect (guard)', () => {
  const p = parseGitCommand('gh api GET repos/foo/bar/pulls');
  assert.equal(p.capability, 'pr_inspect');
});

test('L29 P0-2: git -C repo status is a safe local inspect', () => {
  const p = parseGitCommand('git -C repo status');
  assert.equal(p.capability, 'inspect_repository');
});

test('L30 P0-2: grep on a normal file is not a credential read', () => {
  assert.equal(classifyCommandSemantics('grep something README.md'), 'unrecognized');
  assert.equal(parseGitCommand('grep something README.md').capability, 'run_local_command');
});

test('L31 P0-2: Select-String on a normal file is not a credential read', () => {
  assert.equal(classifyCommandSemantics('Select-String normal.txt'), 'unrecognized');
  assert.equal(parseGitCommand('Select-String normal.txt').capability, 'run_local_command');
});

test('L32 P0-2: python -c with a quoted semicolon print is not a credential read', () => {
  assert.equal(classifyCommandSemantics(`python -c "print(';')"`), 'unrecognized');
});

test('L33 P0-2: echo with quoted && stays one segment and is not a credential read', () => {
  const semantic = classifyCommandSemantics(`echo "a && b"`);
  assert.equal(semantic, 'unrecognized');
  assert.deepEqual(splitChains(`echo "a && b"`), ['echo "a && b"']);
});

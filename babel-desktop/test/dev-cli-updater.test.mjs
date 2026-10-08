// License: Apache-2.0 - see LICENSE
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRemote, isTrustedRemote, inspectDevelopmentCheckout, precheckSafety, planDevelopmentUpdate, resolveNpmInvocation, compareReleaseVersion, normalizeVersion, runDevelopmentUpdate} from '../native/updater.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('isTrustedRemote requires both the exact host and the exact owner/repo', () => {
  assert.equal(isTrustedRemote('https://github.com/gthgomez/Babel.git'), true);
  assert.equal(isTrustedRemote('https://github.com/gthgomez/Babel'), true);
  assert.equal(isTrustedRemote('git@github.com:gthgomez/Babel.git'), true);
  assert.equal(isTrustedRemote('ssh://git@github.com/gthgomez/Babel.git'), true);
  // The host must not be discarded: a same-slug mirror on another host is untrusted.
  assert.equal(isTrustedRemote('https://evil.com/gthgomez/Babel.git'), false);
  assert.equal(isTrustedRemote('https://gitlab.com/gthgomez/Babel.git'), false);
  assert.equal(isTrustedRemote('git@evil.example:gthgomez/Babel.git'), false);
  assert.equal(isTrustedRemote('ssh://git@evil.example/gthgomez/Babel.git'), false);
  // A different owner on the right host is untrusted.
  assert.equal(isTrustedRemote('https://github.com/attacker/Babel.git'), false);
  assert.equal(isTrustedRemote('not a url'), false);
  assert.equal(isTrustedRemote(''), false);
  assert.deepEqual(parseRemote('https://evil.com/gthgomez/Babel.git'), {host:'evil.com', slug:'gthgomez/Babel'});
});

function inspectionGit(state) {
  return async (args) => {
    const key = args.join(' ');
    if (key === 'rev-parse HEAD') return {ok:true, stdout:`${state.head}\n`};
    if (key === 'remote get-url origin') return {ok:true, stdout:`${state.remote ?? 'https://github.com/gthgomez/Babel.git'}\n`};
    if (key === 'rev-parse --abbrev-ref HEAD') return {ok:true, stdout:`${state.branch ?? 'main'}\n`};
    if (key === 'status --porcelain') return {ok:true, stdout:state.dirty ? ' M src/x.ts\n' : ''};
    if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return {ok:true, stdout:'origin/main\n'};
    if (key === 'rev-parse origin/main') return {ok:true, stdout:`${state.upstream}\n`};
    if (key === 'rev-list --left-right --count origin/main...HEAD') return {ok:true, stdout:`${state.behind ?? 0}\t${state.ahead ?? 0}\n`};
    return {ok:false, stdout:''};
  };
}

test('inspectDevelopmentCheckout reports trust, divergence and dirty state', async () => {
  const clean = await inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, ahead:0}), repoRoot:'/repo'});
  assert.equal(clean.ok, true);
  assert.equal(clean.trusted, true);
  assert.equal(clean.behind, 2);
  assert.equal(clean.ahead, 0);
  assert.equal(clean.dirty, false);
  assert.deepEqual(planDevelopmentUpdate(clean).allowed, true);

  const dirty = await inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, dirty:true}), repoRoot:'/repo'});
  assert.equal(precheckSafety(dirty).reason, 'local_modifications');

  const detached = await inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, branch:'HEAD'}), repoRoot:'/repo'});
  assert.equal(precheckSafety(detached).reason, 'detached_head');

  const untrusted = await inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, remote:'https://evil.com/gthgomez/Babel.git'}), repoRoot:'/repo'});
  assert.equal(untrusted.trusted, false);
  assert.equal(precheckSafety(untrusted).reason, 'untrusted_remote');

  const current = await inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_A, behind:0, ahead:0}), repoRoot:'/repo'});
  assert.equal(planDevelopmentUpdate(current).reason, 'already_current');

  const ahead = await inspectDevelopmentCheckout({git:inspectionGit({head:SHA_B, upstream:SHA_A, behind:0, ahead:1}), repoRoot:'/repo'});
  assert.equal(precheckSafety(ahead).reason, 'local_commits_ahead');
});

test('precheckSafety does not require an already-observed upstream (the fetch creates it)', () => {
  const safety = precheckSafety({ok:true, trusted:true, detached:false, dirty:false, ahead:0, upstream:null, behind:0});
  assert.equal(safety.allowed, true);
  assert.equal(planDevelopmentUpdate({ok:true, trusted:true, detached:false, dirty:false, ahead:0, upstream:null, behind:0}).reason, 'no_upstream_observed');
});

test('inspectDevelopmentCheckout fails closed without a git checkout', async () => {
  assert.equal((await inspectDevelopmentCheckout({git:async () => ({ok:false, stdout:''}), repoRoot:'/repo'})).blocker, 'not_a_git_checkout');
  assert.equal((await inspectDevelopmentCheckout({git:async () => ({ok:true, stdout:''}), repoRoot:''})).blocker, 'no_source_checkout');
});

test('resolveNpmInvocation never returns a caller-controlled command string', () => {
  assert.deepEqual(resolveNpmInvocation({platform:'linux', env:{}}), {exe:'npm', args:[], shell:false});
  assert.deepEqual(resolveNpmInvocation({platform:'win32', env:{}}), {exe:'cmd.exe', args:['/d','/s','/c','npm.cmd'], shell:false});
});

test('compareReleaseVersion compares semantic triples and stays explicit on unknown', () => {
  assert.equal(normalizeVersion('v1.2.3-preview.20260101')[1], 2);
  assert.equal(compareReleaseVersion('v0.2.0', '0.1.1').state, 'available');
  assert.equal(compareReleaseVersion('v0.1.1', '0.1.1').state, 'current');
  assert.equal(compareReleaseVersion('v0.1.0', '0.1.1').state, 'current');
  assert.equal(compareReleaseVersion('nonsense', '0.1.1').state, 'unsupported');
});

function statefulGit(state) {
  return async (args) => {
    const key = args.join(' ');
    if (key === 'fetch origin --prune') return {ok:true, stdout:''};
    if (key.startsWith('merge --ff-only')) { if (state.diverged) return {ok:false, stdout:'', detail:'refused'}; state.head = state.upstream; return {ok:true, stdout:''}; }
    if (key === 'rev-parse HEAD') return {ok:true, stdout:`${state.head}\n`};
    if (key === 'remote get-url origin') return {ok:true, stdout:`${state.remote ?? 'https://github.com/gthgomez/Babel.git'}\n`};
    if (key === 'rev-parse --abbrev-ref HEAD') return {ok:true, stdout:'main\n'};
    if (key === 'status --porcelain') return {ok:true, stdout:''};
    if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return {ok:true, stdout:'origin/main\n'};
    if (key === 'rev-parse origin/main') return {ok:true, stdout:`${state.upstream}\n`};
    if (key.startsWith('rev-list --left-right')) return {ok:true, stdout:state.head === state.upstream ? '0\t0\n' : '2\t0\n'};
    return {ok:false, stdout:''};
  };
}

function makeCheckout({withDist = true} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'babel-updater-'));
  const cliDir = join(root, 'babel-cli');
  mkdirSync(cliDir, {recursive:true});
  if (withDist) {
    mkdirSync(join(cliDir, 'dist'), {recursive:true});
    writeFileSync(join(cliDir, 'dist', 'index.js'), '// original build');
  }
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({name:'babel-harness', version:'0.1.1'}));
  return {root, cliDir, snapshotDir:join(root, 'rollback')};
}

test('runDevelopmentUpdate fast-forwards, rebuilds, validates and reports the new SHA', async () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  const state = {head:SHA_A, upstream:SHA_B};
  const calls = [];
  const run = async (exe, args) => { const key = args.join(' '); calls.push(key); return key.endsWith('--version') ? {ok:true, stdout:'0.1.1\n'} : {ok:true, stdout:''}; };
  const result = await runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.previousSha, SHA_A);
  assert.equal(result.sourceSha, SHA_B);
  assert.equal(result.version, '0.1.1');
  assert.equal(state.head, SHA_B);
  assert.ok(calls.includes('ci') && calls.includes('run build'));
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate refuses a dirty checkout before touching the tree', async () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  let fetched = false;
  const git = async (args) => {
    const key = args.join(' ');
    if (key === 'fetch origin --prune') { fetched = true; return {ok:true, stdout:''}; }
    if (key === 'rev-parse HEAD') return {ok:true, stdout:`${SHA_A}\n`};
    if (key === 'remote get-url origin') return {ok:true, stdout:'https://github.com/gthgomez/Babel.git\n'};
    if (key === 'rev-parse --abbrev-ref HEAD') return {ok:true, stdout:'main\n'};
    if (key === 'status --porcelain') return {ok:true, stdout:' M src/x.ts\n'};
    return {ok:true, stdout:''};
  };
  const result = await runDevelopmentUpdate({git, run:async () => ({ok:true, stdout:''}), repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'precheck');
  assert.equal(result.reason, 'local_modifications');
  assert.equal(fetched, false, 'no fetch may happen on an unsafe checkout');
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate refuses an untrusted remote host and never fetches', async () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  let fetched = false;
  const git = async (args) => {
    const key = args.join(' ');
    if (key === 'fetch origin --prune') { fetched = true; return {ok:true, stdout:''}; }
    if (key === 'rev-parse HEAD') return {ok:true, stdout:`${SHA_A}\n`};
    if (key === 'remote get-url origin') return {ok:true, stdout:'https://evil.com/gthgomez/Babel.git\n'};
    if (key === 'rev-parse --abbrev-ref HEAD') return {ok:true, stdout:'main\n'};
    if (key === 'status --porcelain') return {ok:true, stdout:''};
    return {ok:true, stdout:''};
  };
  const result = await runDevelopmentUpdate({git, run:async () => ({ok:true, stdout:''}), repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'untrusted_remote');
  assert.equal(fetched, false, 'an untrusted host must never be fetched');
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate restores the previous build when the rebuild fails', async () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  const state = {head:SHA_A, upstream:SHA_B};
  const run = async (exe, args) => {
    const key = args.join(' ');
    if (key === 'run build') { writeFileSync(join(cliDir, 'dist', 'index.js'), '// broken build'); return {ok:false, detail:'tsc failed'}; }
    return {ok:true, stdout:''};
  };
  const result = await runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'build');
  assert.equal(result.reason, 'build_failed');
  assert.equal(result.treeAdvanced, true);
  assert.equal(readFileSync(join(cliDir, 'dist', 'index.js'), 'utf8'), '// original build', 'the previous dist must be restored');
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate removes a partial dist when there was no previous build', async () => {
  const {root, cliDir, snapshotDir} = makeCheckout({withDist:false});
  const state = {head:SHA_A, upstream:SHA_B};
  const run = async (exe, args) => {
    const key = args.join(' ');
    if (key === 'run build') { mkdirSync(join(cliDir, 'dist'), {recursive:true}); writeFileSync(join(cliDir, 'dist', 'index.js'), '// partial'); return {ok:false, detail:'tsc failed'}; }
    return {ok:true, stdout:''};
  };
  const result = await runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build_failed');
  assert.equal(existsSync(join(cliDir, 'dist')), false, 'a partial build must not be left behind');
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate rejects a rebuilt CLI whose version does not match its package', async () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  const state = {head:SHA_A, upstream:SHA_B};
  const run = async (exe, args) => { const key = args.join(' '); return key.endsWith('--version') ? {ok:true, stdout:'9.9.9\n'} : {ok:true, stdout:''}; };
  const result = await runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'version_mismatch');
  rmSync(root, {recursive:true, force:true});
});

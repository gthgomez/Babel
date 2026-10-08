// License: Apache-2.0 - see LICENSE
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRemoteSlug, inspectDevelopmentCheckout, planDevelopmentUpdate, resolveNpmInvocation, compareReleaseVersion, normalizeVersion, runDevelopmentUpdate} from '../native/updater.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('parseRemoteSlug accepts the trusted URL shapes and rejects others', () => {
  assert.equal(parseRemoteSlug('https://github.com/gthgomez/Babel.git'), 'gthgomez/Babel');
  assert.equal(parseRemoteSlug('https://github.com/gthgomez/Babel'), 'gthgomez/Babel');
  assert.equal(parseRemoteSlug('git@github.com:gthgomez/Babel.git'), 'gthgomez/Babel');
  assert.equal(parseRemoteSlug('ssh://git@github.com/gthgomez/Babel.git'), 'gthgomez/Babel');
  assert.equal(parseRemoteSlug('https://example.com/other/repo.git'), 'other/repo');
  assert.equal(parseRemoteSlug('not a url'), null);
  assert.equal(parseRemoteSlug(''), null);
});

function inspectionGit(state) {
  return (args) => {
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

test('inspectDevelopmentCheckout reports trust, divergence and dirty state', () => {
  const clean = inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, ahead:0}), repoRoot:'/repo'});
  assert.equal(clean.ok, true);
  assert.equal(clean.trusted, true);
  assert.equal(clean.behind, 2);
  assert.equal(clean.ahead, 0);
  assert.equal(clean.dirty, false);
  assert.deepEqual(planDevelopmentUpdate(clean).allowed, true);

  const dirty = inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, dirty:true}), repoRoot:'/repo'});
  assert.equal(planDevelopmentUpdate(dirty).reason, 'local_modifications');

  const detached = inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, branch:'HEAD'}), repoRoot:'/repo'});
  assert.equal(planDevelopmentUpdate(detached).reason, 'detached_head');

  const untrusted = inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_B, behind:2, remote:'https://github.com/other/Babel.git'}), repoRoot:'/repo'});
  assert.equal(planDevelopmentUpdate(untrusted).reason, 'untrusted_remote');

  const current = inspectDevelopmentCheckout({git:inspectionGit({head:SHA_A, upstream:SHA_A, behind:0, ahead:0}), repoRoot:'/repo'});
  assert.equal(planDevelopmentUpdate(current).reason, 'already_current');

  const ahead = inspectDevelopmentCheckout({git:inspectionGit({head:SHA_B, upstream:SHA_A, behind:0, ahead:1}), repoRoot:'/repo'});
  assert.equal(planDevelopmentUpdate(ahead).reason, 'local_commits_ahead');
});

test('inspectDevelopmentCheckout fails closed without a git checkout', () => {
  assert.equal(inspectDevelopmentCheckout({git:() => ({ok:false, stdout:''}), repoRoot:'/repo'}).blocker, 'not_a_git_checkout');
  assert.equal(inspectDevelopmentCheckout({git:() => ({ok:true, stdout:''}), repoRoot:''}).blocker, 'no_source_checkout');
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
  return (args) => {
    const key = args.join(' ');
    if (key === 'fetch origin --prune') return {ok:true, stdout:''};
    if (key.startsWith('merge --ff-only')) { if (state.diverged) return {ok:false, stdout:'', detail:'refused'}; state.head = state.upstream; return {ok:true, stdout:''}; }
    if (key === 'rev-parse HEAD') return {ok:true, stdout:`${state.head}\n`};
    if (key === 'remote get-url origin') return {ok:true, stdout:'https://github.com/gthgomez/Babel.git\n'};
    if (key === 'rev-parse --abbrev-ref HEAD') return {ok:true, stdout:'main\n'};
    if (key === 'status --porcelain') return {ok:true, stdout:''};
    if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return {ok:true, stdout:'origin/main\n'};
    if (key === 'rev-parse origin/main') return {ok:true, stdout:`${state.upstream}\n`};
    if (key.startsWith('rev-list --left-right')) return {ok:true, stdout:state.head === state.upstream ? '0\t0\n' : '2\t0\n'};
    return {ok:false, stdout:''};
  };
}

function makeCheckout() {
  const root = mkdtempSync(join(tmpdir(), 'babel-updater-'));
  const cliDir = join(root, 'babel-cli');
  mkdirSync(join(cliDir, 'dist'), {recursive:true});
  writeFileSync(join(cliDir, 'dist', 'index.js'), '// original build');
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({name:'babel-harness', version:'0.1.1'}));
  return {root, cliDir, snapshotDir:join(root, 'rollback')};
}

test('runDevelopmentUpdate fast-forwards, rebuilds, validates and reports the new SHA', () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  const state = {head:SHA_A, upstream:SHA_B};
  const calls = [];
  const run = (exe, args) => { const key = args.join(' '); calls.push(key); if (key.endsWith('--version')) return {ok:true, stdout:'0.1.1\n'}; return {ok:true, stdout:''}; };
  const result = runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.previousSha, SHA_A);
  assert.equal(result.sourceSha, SHA_B);
  assert.equal(result.version, '0.1.1');
  assert.equal(state.head, SHA_B);
  assert.ok(calls.includes('ci') && calls.includes('run build'));
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate refuses a dirty checkout before touching the tree', () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  let fetched = false;
  const git = (args) => {
    const key = args.join(' ');
    if (key === 'fetch origin --prune') { fetched = true; return {ok:true, stdout:''}; }
    if (key === 'rev-parse HEAD') return {ok:true, stdout:`${SHA_A}\n`};
    if (key === 'remote get-url origin') return {ok:true, stdout:'https://github.com/gthgomez/Babel.git\n'};
    if (key === 'rev-parse --abbrev-ref HEAD') return {ok:true, stdout:'main\n'};
    if (key === 'status --porcelain') return {ok:true, stdout:' M src/x.ts\n'};
    return {ok:true, stdout:''};
  };
  const result = runDevelopmentUpdate({git, run:() => ({ok:true, stdout:''}), repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'precheck');
  assert.equal(result.reason, 'local_modifications');
  assert.equal(fetched, false, 'no fetch may happen on an unsafe checkout');
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate restores the previous build when the rebuild fails', () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  const state = {head:SHA_A, upstream:SHA_B};
  const run = (exe, args) => {
    const key = args.join(' ');
    if (key === 'run build') { writeFileSync(join(cliDir, 'dist', 'index.js'), '// broken build'); return {ok:false, detail:'tsc failed'}; }
    return {ok:true, stdout:''};
  };
  const result = runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'build');
  assert.equal(result.reason, 'build_failed');
  assert.equal(readFileSync(join(cliDir, 'dist', 'index.js'), 'utf8'), '// original build', 'the previous dist must be restored');
  rmSync(root, {recursive:true, force:true});
});

test('runDevelopmentUpdate rejects a rebuilt CLI whose version does not match its package', () => {
  const {root, cliDir, snapshotDir} = makeCheckout();
  const state = {head:SHA_A, upstream:SHA_B};
  const run = (exe, args) => { const key = args.join(' '); return key.endsWith('--version') ? {ok:true, stdout:'9.9.9\n'} : {ok:true, stdout:''}; };
  const result = runDevelopmentUpdate({git:statefulGit(state), run, repoRoot:root, cliDir, nodeExe:'node', npm:{exe:'npm', args:[]}, snapshotDir, events:() => {}});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'version_mismatch');
  rmSync(root, {recursive:true, force:true});
});

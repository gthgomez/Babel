// License: Apache-2.0 - see LICENSE
// Development CLI updater. For an explicitly trusted local Babel checkout this
// inspects git state, refuses unsafe updates, fetches the trusted upstream,
// fast-forwards only, rebuilds the canonical CLI with the repository's own
// commands, validates the result, and keeps the previous build for rollback.
// Every child process is a fixed command with validated arguments and a
// bounded lifetime. No shell command string, force reset, or branch change.
import {existsSync, mkdirSync, cpSync, rmSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

export const EXPECTED_ORIGIN = 'gthgomez/Babel';
export const GIT_TIMEOUT_MS = 120000;
export const BUILD_TIMEOUT_MS = 900000;
export const MAX_BUFFER = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;

/** Extract an owner/repo slug from a git remote URL (https or ssh). */
export function parseRemoteSlug(url) {
  const value = String(url ?? '').trim();
  const match = value.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)[^/:]+[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) return null;
  const slug = match[1].replace(/\.git$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug : null;
}

/** Fixed, bounded git runner. Arguments are code-owned; no caller text is interpolated. */
export function createGitRunner({exec = execFileSync, timeout = GIT_TIMEOUT_MS} = {}) {
  return (args, cwd) => {
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('git arguments must be strings');
    try {
      const stdout = exec('git', args, {cwd, encoding:'utf8', windowsHide:true, timeout, maxBuffer:MAX_BUFFER, stdio:['ignore','pipe','pipe']});
      return {ok:true, stdout:String(stdout)};
    } catch (error) {
      return {ok:false, stdout:'', detail:String(error?.stderr ?? error?.message ?? '').slice(0,400)};
    }
  };
}

/**
 * Read-only inspection of a candidate source checkout. Never mutates the tree.
 * @param {{git:Function, repoRoot:string}} input
 */
export function inspectDevelopmentCheckout({git, repoRoot}) {
  if (typeof repoRoot !== 'string' || !repoRoot) return {ok:false, blocker:'no_source_checkout'};
  const head = git(['rev-parse', 'HEAD'], repoRoot);
  if (!head.ok || !SHA.test(head.stdout.trim())) return {ok:false, blocker:'not_a_git_checkout'};
  const remote = git(['remote', 'get-url', 'origin'], repoRoot);
  const remoteUrl = remote.ok ? remote.stdout.trim() : '';
  const remoteSlug = parseRemoteSlug(remoteUrl);
  const branchRef = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const branch = branchRef.ok ? branchRef.stdout.trim() : '';
  const status = git(['status', '--porcelain'], repoRoot);
  const dirty = Boolean(status.ok && status.stdout.trim().length > 0);
  const defaultRef = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
  const upstreamRef = defaultRef.ok && defaultRef.stdout.trim() ? defaultRef.stdout.trim() : 'origin/main';
  const upstream = git(['rev-parse', upstreamRef], repoRoot);
  let ahead = 0;
  let behind = 0;
  if (upstream.ok && SHA.test(upstream.stdout.trim())) {
    const counts = git(['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`], repoRoot);
    if (counts.ok) {
      const [b, a] = counts.stdout.trim().split(/\s+/).map(Number);
      behind = Number.isFinite(b) ? b : 0;
      ahead = Number.isFinite(a) ? a : 0;
    }
  }
  return {
    ok:true,
    repoRoot,
    remoteUrl,
    remoteSlug,
    trusted: remoteSlug === EXPECTED_ORIGIN,
    detached: branch === 'HEAD',
    branch: branch && branch !== 'HEAD' ? branch : null,
    upstreamRef,
    head: head.stdout.trim(),
    upstream: upstream.ok && SHA.test(upstream.stdout.trim()) ? upstream.stdout.trim() : null,
    dirty,
    ahead,
    behind,
  };
}

/** Decide whether a fast-forward update is safe. Fail closed with a named reason. */
export function planDevelopmentUpdate(inspection) {
  if (!inspection || inspection.ok !== true) return {allowed:false, reason:inspection?.blocker ?? 'not_inspected'};
  if (!inspection.trusted) return {allowed:false, reason:'untrusted_remote'};
  if (inspection.detached) return {allowed:false, reason:'detached_head'};
  if (inspection.dirty) return {allowed:false, reason:'local_modifications'};
  if (!inspection.upstream) return {allowed:false, reason:'no_upstream_observed'};
  if (inspection.ahead > 0) return {allowed:false, reason:'local_commits_ahead'};
  if (inspection.behind === 0) return {allowed:false, reason:'already_current'};
  return {allowed:true, reason:'fast_forward_available', currentSha:inspection.head, incomingSha:inspection.upstream, incomingCount:inspection.behind, upstreamRef:inspection.upstreamRef};
}

/** Resolve a fixed npm invocation. Arguments stay code-owned; no shell text from callers. */
export function resolveNpmInvocation({platform = process.platform, env = process.env} = {}) {
  if (platform === 'win32') return {exe:env.ComSpec || env.COMSPEC || 'cmd.exe', args:['/d','/s','/c','npm.cmd'], shell:false};
  return {exe:'npm', args:[], shell:false};
}

/** Fixed, bounded command runner used by the updater phases. */
export function createStepRunner({exec = execFileSync, timeout = BUILD_TIMEOUT_MS} = {}) {
  return (exe, args, cwd, {timeout: stepTimeout = timeout, env} = {}) => {
    if (typeof exe !== 'string' || !Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('invalid command');
    try {
      const options = {cwd, encoding:'utf8', windowsHide:true, timeout:stepTimeout, maxBuffer:MAX_BUFFER, stdio:['ignore','pipe','pipe']};
      if (env) options.env = {...process.env, ...env};
      const stdout = exec(exe, args, options);
      return {ok:true, stdout:String(stdout)};
    } catch (error) {
      return {ok:false, stdout:'', detail:String(error?.stderr ?? error?.message ?? '').slice(0,600)};
    }
  };
}

function readPackageVersion(cliDir) {
  try { return JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

/** Parse a leading semantic version triple (tolerates a v prefix and a suffix). */
export function normalizeVersion(value) {
  const match = String(value ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Compare a published release against the running version. Unknown is explicit. */
export function compareReleaseVersion(latest, current) {
  const a = normalizeVersion(latest);
  const b = normalizeVersion(current);
  if (!a || !b) return {state:'unsupported', detail:'Version comparison unavailable for the observed tags'};
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return {state:'available', detail:`Published ${latest} is newer than ${current}`};
    if (a[i] < b[i]) return {state:'current', detail:`Published ${latest} is not newer than ${current}`};
  }
  return {state:'current', detail:`Published ${latest} matches ${current}`};
}

/**
 * Execute the development update. The caller must have obtained explicit user
 * consent first. Fails closed; the previous dist is restored if the rebuild or
 * validation fails.
 * @param {object} input
 * @param {Function} input.git fixed git runner
 * @param {Function} input.run fixed step runner
 * @param {string} input.repoRoot
 * @param {string} input.cliDir absolute babel-cli directory
 * @param {string} input.nodeExe absolute node executable used to validate
 * @param {{exe:string,args:string[]}} input.npm resolved npm invocation
 * @param {string} input.snapshotDir absolute directory for the rollback copy
 * @param {Function} [input.events]
 */
export function runDevelopmentUpdate({git, run, repoRoot, cliDir, nodeExe, nodeEnv = {}, npm, snapshotDir, events = () => {}}) {
  const emit = (phase, status, detail = '') => events({phase, status, detail:String(detail).slice(0,600)});
  const fail = (phase, reason, detail = '') => { emit(phase, 'failed', detail || reason); return {ok:false, phase, reason, detail}; };

  const before = inspectDevelopmentCheckout({git, repoRoot});
  if (!before.ok) return fail('inspect', before.blocker);
  emit('inspect', 'complete', `HEAD ${before.head.slice(0,12)} on ${before.branch ?? 'detached'}`);

  const precheck = planDevelopmentUpdate({...before, behind:1});
  if (!precheck.allowed) return fail('precheck', precheck.reason);

  emit('fetch', 'running');
  const fetched = git(['fetch', 'origin', '--prune'], repoRoot);
  if (!fetched.ok) return fail('fetch', 'fetch_failed', fetched.detail);
  emit('fetch', 'complete');

  const after = inspectDevelopmentCheckout({git, repoRoot});
  const plan = planDevelopmentUpdate(after);
  if (!plan.allowed) return fail('plan', plan.reason);
  emit('plan', 'complete', `${plan.incomingCount} incoming commit(s): ${plan.currentSha.slice(0,12)} -> ${plan.incomingSha.slice(0,12)}`);

  const distDir = join(cliDir, 'dist');
  const backupDir = join(snapshotDir, `dist-${before.head.slice(0,12)}`);
  let backed = false;
  if (existsSync(distDir)) {
    try {
      rmSync(backupDir, {recursive:true, force:true});
      mkdirSync(backupDir, {recursive:true});
      cpSync(distDir, backupDir, {recursive:true});
      backed = true;
      emit('backup', 'complete', backupDir);
    } catch (error) { return fail('backup', 'backup_failed', error.message); }
  }

  emit('fast-forward', 'running');
  const ff = git(['merge', '--ff-only', plan.upstreamRef], repoRoot);
  if (!ff.ok) return fail('fast-forward', 'fast_forward_failed', ff.detail);
  const headAfter = git(['rev-parse', 'HEAD'], repoRoot);
  const newSha = headAfter.ok && SHA.test(headAfter.stdout.trim()) ? headAfter.stdout.trim() : plan.incomingSha;
  emit('fast-forward', 'complete', newSha.slice(0,12));

  const restore = () => {
    if (!backed) return;
    try { rmSync(distDir, {recursive:true, force:true}); cpSync(backupDir, distDir, {recursive:true}); emit('rollback', 'complete', before.head.slice(0,12)); }
    catch (error) { emit('rollback', 'failed', error.message); }
  };

  emit('install', 'running');
  const installed = run(npm.exe, [...npm.args, 'ci'], cliDir, {timeout:BUILD_TIMEOUT_MS});
  if (!installed.ok) { restore(); return fail('install', 'dependency_install_failed', installed.detail); }
  emit('install', 'complete');

  emit('build', 'running');
  const built = run(npm.exe, [...npm.args, 'run', 'build'], cliDir, {timeout:BUILD_TIMEOUT_MS});
  if (!built.ok) { restore(); return fail('build', 'build_failed', built.detail); }
  emit('build', 'complete');

  const entry = join(distDir, 'index.js');
  if (!existsSync(entry)) { restore(); return fail('validate', 'missing_entry'); }
  const expected = readPackageVersion(cliDir);
  emit('validate', 'running');
  const version = run(nodeExe, [entry, '--version'], cliDir, {timeout:60000, env:nodeEnv});
  if (!version.ok) { restore(); return fail('validate', 'version_check_failed', version.detail); }
  const reported = version.stdout.trim();
  if (!expected || reported !== expected) { restore(); return fail('validate', 'version_mismatch', `expected ${expected ?? 'unknown'}, got ${reported}`); }
  emit('validate', 'complete', reported);

  emit('activate', 'complete', newSha.slice(0,12));
  return {ok:true, previousSha:before.head, sourceSha:newSha, version:reported, backupDir:backed ? backupDir : null};
}

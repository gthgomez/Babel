// License: Apache-2.0 - see LICENSE
// Development CLI updater. For an explicitly trusted local Babel checkout this
// inspects git state, refuses unsafe updates, fetches the trusted upstream,
// fast-forwards only, rebuilds the canonical CLI with the repository's own
// commands, validates the result, and keeps the previous build for rollback.
// Every child process is a fixed command with validated arguments and a
// bounded lifetime; commands run asynchronously so the app stays responsive.
// No shell command string, force reset, or branch change.
import {existsSync, mkdirSync, cpSync, rmSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {execFile} from 'node:child_process';

export const EXPECTED_ORIGIN = 'gthgomez/Babel';
/** Only GitHub may host the trusted origin. A mirror on another host is never trusted. */
export const EXPECTED_HOST = 'github.com';
export const GIT_TIMEOUT_MS = 120000;
export const BUILD_TIMEOUT_MS = 900000;
export const MAX_BUFFER = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;

/**
 * Parse a git remote URL into its host and owner/repo slug. Returns null for
 * anything that is not a recognized https/ssh remote. The host is retained so
 * trust can require both the exact host and the exact slug.
 */
export function parseRemote(url) {
  const value = String(url ?? '').trim();
  const match = value.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) return null;
  const host = match[1].toLowerCase();
  const slug = match[2].replace(/\.git$/, '');
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return null;
  return {host, slug};
}

/** A remote is trusted only when BOTH the host and the owner/repo match exactly. */
export function isTrustedRemote(url) {
  const remote = parseRemote(url);
  return Boolean(remote && remote.host === EXPECTED_HOST && remote.slug === EXPECTED_ORIGIN);
}

function capture(exe, args, options, limit) {
  return new Promise(resolvePromise => {
    execFile(exe, args, {...options, encoding:'utf8', maxBuffer:MAX_BUFFER, windowsHide:true, stdio:['ignore','pipe','pipe']}, (error, stdout, stderr) => {
      if (error) resolvePromise({ok:false, stdout:'', detail:String(stderr ?? error?.message ?? '').slice(0, limit)});
      else resolvePromise({ok:true, stdout:String(stdout)});
    });
  });
}

/** Async, bounded git runner. Arguments are code-owned; no caller text is interpolated. */
export function createGitRunner({timeout = GIT_TIMEOUT_MS, spawn = capture} = {}) {
  return (args, cwd) => {
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('git arguments must be strings');
    return spawn('git', args, {cwd, timeout}, 400);
  };
}

/** Async, bounded command runner used by the updater phases. */
export function createStepRunner({timeout = BUILD_TIMEOUT_MS, spawn = capture} = {}) {
  return (exe, args, cwd, {timeout: stepTimeout = timeout, env} = {}) => {
    if (typeof exe !== 'string' || !Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('invalid command');
    const options = {cwd, timeout:stepTimeout};
    if (env) options.env = {...process.env, ...env};
    return spawn(exe, args, options, 600);
  };
}

/**
 * Read-only inspection of a candidate source checkout. Never mutates the tree.
 * @param {{git:Function, repoRoot:string}} input
 */
export async function inspectDevelopmentCheckout({git, repoRoot}) {
  if (typeof repoRoot !== 'string' || !repoRoot) return {ok:false, blocker:'no_source_checkout'};
  const head = await git(['rev-parse', 'HEAD'], repoRoot);
  if (!head.ok || !SHA.test(head.stdout.trim())) return {ok:false, blocker:'not_a_git_checkout'};
  const remote = await git(['remote', 'get-url', 'origin'], repoRoot);
  const remoteUrl = remote.ok ? remote.stdout.trim() : '';
  const branchRef = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const branch = branchRef.ok ? branchRef.stdout.trim() : '';
  const status = await git(['status', '--porcelain'], repoRoot);
  const dirty = Boolean(status.ok && status.stdout.trim().length > 0);
  const defaultRef = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
  const upstreamRef = defaultRef.ok && defaultRef.stdout.trim() ? defaultRef.stdout.trim() : 'origin/main';
  const upstream = await git(['rev-parse', upstreamRef], repoRoot);
  let ahead = 0;
  let behind = 0;
  let countsOk = false;
  if (upstream.ok && SHA.test(upstream.stdout.trim())) {
    const counts = await git(['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`], repoRoot);
    const [behindRaw, aheadRaw] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [];
    // countsOk requires a real, parseable two-integer result; a successful
    // command with truncated/garbage output must not read as "not ahead".
    if (Number.isFinite(behindRaw) && Number.isFinite(aheadRaw)) {
      behind = behindRaw;
      ahead = aheadRaw;
      countsOk = true;
    }
  }
  return {
    ok:true,
    repoRoot,
    remoteUrl,
    remoteHost: parseRemote(remoteUrl)?.host ?? null,
    remoteSlug: parseRemote(remoteUrl)?.slug ?? null,
    trusted: isTrustedRemote(remoteUrl),
    detached: branch === 'HEAD',
    branch: branch && branch !== 'HEAD' ? branch : null,
    upstreamRef,
    head: head.stdout.trim(),
    upstream: upstream.ok && SHA.test(upstream.stdout.trim()) ? upstream.stdout.trim() : null,
    dirty,
    // A failed worktree/branch/divergence probe is never silently read as
    // "clean"/"attached"/"current": precheckSafety and planDevelopmentUpdate
    // fail closed on these flags.
    statusOk: status.ok,
    branchOk: branchRef.ok,
    countsOk,
    ahead,
    behind,
  };
}

/** Safety checks that must hold before fetching. Deliberately does not require an observed upstream. */
export function precheckSafety(inspection) {
  if (!inspection || inspection.ok !== true) return {allowed:false, reason:inspection?.blocker ?? 'not_inspected'};
  if (!inspection.trusted) return {allowed:false, reason:'untrusted_remote'};
  // A failed `git status`/branch probe must never be read as "clean"/"attached".
  if (!inspection.statusOk) return {allowed:false, reason:'status_unavailable'};
  if (!inspection.branchOk) return {allowed:false, reason:'branch_unavailable'};
  if (inspection.detached) return {allowed:false, reason:'detached_head'};
  if (inspection.dirty) return {allowed:false, reason:'local_modifications'};
  if (inspection.ahead > 0) return {allowed:false, reason:'local_commits_ahead'};
  return {allowed:true, reason:'safe_to_fetch'};
}

/** Decide whether a fast-forward update is safe, using a post-fetch inspection. Fail closed. */
export function planDevelopmentUpdate(inspection) {
  const safety = precheckSafety(inspection);
  if (!safety.allowed) return safety;
  if (!inspection.upstream) return {allowed:false, reason:'no_upstream_observed'};
  // A failed divergence probe must never be read as "already current".
  if (!inspection.countsOk) return {allowed:false, reason:'divergence_unavailable'};
  if (inspection.behind === 0) return {allowed:false, reason:'already_current'};
  return {allowed:true, reason:'fast_forward_available', currentSha:inspection.head, incomingSha:inspection.upstream, incomingCount:inspection.behind, upstreamRef:inspection.upstreamRef};
}

/** Resolve a fixed npm invocation. Arguments stay code-owned; no shell text from callers. */
export function resolveNpmInvocation({platform = process.platform, env = process.env} = {}) {
  if (platform === 'win32') return {exe:env.ComSpec || env.COMSPEC || 'cmd.exe', args:['/d','/s','/c','npm.cmd'], shell:false};
  return {exe:'npm', args:[], shell:false};
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
 * validation fails, and any partial dist is removed when there was none before.
 * @param {object} input
 * @param {Function} input.git async git runner
 * @param {Function} input.run async step runner
 * @param {string} input.repoRoot
 * @param {string} input.cliDir absolute babel-cli directory
 * @param {string} input.nodeExe absolute node executable used to validate
 * @param {string} [input.nodeEnv] extra env for the validation node run
 * @param {{exe:string,args:string[]}} input.npm resolved npm invocation
 * @param {string} input.snapshotDir absolute directory for the rollback copy
 * @param {Function} [input.events]
 */
export async function runDevelopmentUpdate({git, run, repoRoot, cliDir, nodeExe, nodeEnv = {}, npm, snapshotDir, events = () => {}}) {
  const emit = (phase, status, detail = '') => events({phase, status, detail:String(detail).slice(0,600)});
  let ffApplied = false;
  const fail = (phase, reason, detail = '') => { emit(phase, 'failed', detail || reason); return {ok:false, phase, reason, detail, treeAdvanced:ffApplied}; };

  const before = await inspectDevelopmentCheckout({git, repoRoot});
  if (!before.ok) return fail('inspect', before.blocker);
  emit('inspect', 'complete', `HEAD ${before.head.slice(0,12)} on ${before.branch ?? 'detached'}`);

  const pre = precheckSafety(before);
  if (!pre.allowed) return fail('precheck', pre.reason);

  emit('fetch', 'running');
  const fetched = await git(['fetch', 'origin', '--prune'], repoRoot);
  if (!fetched.ok) return fail('fetch', 'fetch_failed', fetched.detail);
  emit('fetch', 'complete');

  const after = await inspectDevelopmentCheckout({git, repoRoot});
  const plan = planDevelopmentUpdate(after);
  if (!plan.allowed) return fail('plan', plan.reason);
  emit('plan', 'complete', `${plan.incomingCount} incoming commit(s): ${plan.currentSha.slice(0,12)} -> ${plan.incomingSha.slice(0,12)}`);

  // Back up the current dist (or record its absence) so any later failure can
  // restore the exact prior state instead of leaving a partial build behind.
  const distDir = join(cliDir, 'dist');
  const backupDir = join(snapshotDir, `dist-${before.head.slice(0,12)}`);
  const hadDist = existsSync(distDir);
  try {
    rmSync(backupDir, {recursive:true, force:true});
    mkdirSync(backupDir, {recursive:true});
    if (hadDist) cpSync(distDir, backupDir, {recursive:true});
    emit('backup', 'complete', hadDist ? backupDir : 'no previous build');
  } catch (error) { return fail('backup', 'backup_failed', error.message); }

  const restore = () => {
    try {
      rmSync(distDir, {recursive:true, force:true});
      if (hadDist) cpSync(backupDir, distDir, {recursive:true});
      emit('rollback', 'complete', hadDist ? before.head.slice(0,12) : 'removed partial build');
    } catch (error) { emit('rollback', 'failed', error.message); }
  };

  emit('fast-forward', 'running');
  const ff = await git(['merge', '--ff-only', plan.upstreamRef], repoRoot);
  if (!ff.ok) { restore(); return fail('fast-forward', 'fast_forward_failed', ff.detail); }
  ffApplied = true;
  const headAfter = await git(['rev-parse', 'HEAD'], repoRoot);
  const newSha = headAfter.ok && SHA.test(headAfter.stdout.trim()) ? headAfter.stdout.trim() : plan.incomingSha;
  emit('fast-forward', 'complete', newSha.slice(0,12));

  emit('install', 'running');
  const installed = await run(npm.exe, [...npm.args, 'ci'], cliDir, {timeout:BUILD_TIMEOUT_MS});
  if (!installed.ok) { restore(); return fail('install', 'dependency_install_failed', installed.detail); }
  emit('install', 'complete');

  emit('build', 'running');
  const built = await run(npm.exe, [...npm.args, 'run', 'build'], cliDir, {timeout:BUILD_TIMEOUT_MS});
  if (!built.ok) { restore(); return fail('build', 'build_failed', built.detail); }
  emit('build', 'complete');

  const entry = join(distDir, 'index.js');
  if (!existsSync(entry)) { restore(); return fail('validate', 'missing_entry'); }
  const expected = readPackageVersion(cliDir);
  emit('validate', 'running');
  const version = await run(nodeExe, [entry, '--version'], cliDir, {timeout:60000, env:nodeEnv});
  if (!version.ok) { restore(); return fail('validate', 'version_check_failed', version.detail); }
  const reported = version.stdout.trim();
  if (!expected || reported !== expected) { restore(); return fail('validate', 'version_mismatch', `expected ${expected ?? 'unknown'}, got ${reported}`); }
  emit('validate', 'complete', reported);

  emit('activate', 'complete', newSha.slice(0,12));
  return {ok:true, previousSha:before.head, sourceSha:newSha, version:reported, backupDir:hadDist ? backupDir : null};
}

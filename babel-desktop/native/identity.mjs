// License: Apache-2.0 - see LICENSE
// Engine identity: the exact CLI build the Desktop will run, its provenance,
// and whether a newer build is available. Values come only from real sources
// (git for a source checkout, the packager's BUILD.json for a bundled build).
// Missing values are reported as unknown; they are never invented.
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

/** Bound every git probe so identity collection never blocks the UI. */
export const GIT_TIMEOUT_MS = 4000;
const SHA = /^[a-f0-9]{40}$/;

/** Where the running engine came from. A packaged build never uses a user entry. */
export function classifyOrigin({isPackaged, advancedEntry, officialReady}) {
  if (isPackaged) return officialReady ? 'bundled' : 'missing';
  if (advancedEntry) return 'advanced';
  return officialReady ? 'official' : 'missing';
}

/** Parse the packager's BUILD.json record. Absent fields stay null; never invented. */
export function parseBuildMetadata(text) {
  let value;
  try { value = JSON.parse(String(text)); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  return {
    version: typeof value.version === 'string' ? value.version : null,
    cliVersion: typeof value.cliVersion === 'string' ? value.cliVersion : null,
    sourceSha: SHA.test(String(value.sourceSha)) ? String(value.sourceSha) : null,
    platform: typeof value.platform === 'string' ? value.platform : null,
    signed: typeof value.signed === 'boolean' ? value.signed : null,
  };
}

/** Build a source descriptor from observed git output. Unknown is explicit. */
export function describeSource({commitSha, branch, dirty} = {}) {
  if (!SHA.test(String(commitSha))) return {kind:'unknown', commitSha:null, branch:null, dirty:null};
  return {
    kind:'git',
    commitSha:String(commitSha),
    branch: typeof branch === 'string' && branch && branch !== 'HEAD' ? branch.slice(0,200) : null,
    dirty: dirty === true,
  };
}

/** Normalize an update check. "Current"/"available" require an actual check. */
export function normalizeUpdate(input) {
  const allowed = new Set(['unchecked','checking','current','available','error','unsupported']);
  const state = allowed.has(input?.state) ? input.state : 'unchecked';
  return {
    state,
    channel: input?.channel === 'release' || input?.channel === 'development' ? input.channel : null,
    currentSha: SHA.test(String(input?.currentSha)) ? String(input.currentSha) : null,
    availableSha: SHA.test(String(input?.availableSha)) ? String(input.availableSha) : null,
    detail: String(input?.detail ?? '').slice(0,400),
  };
}

function defaultReadText(path) { return readFileSync(path, 'utf8'); }
function defaultGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {cwd, encoding:'utf8', timeout:GIT_TIMEOUT_MS, windowsHide:true, maxBuffer:256 * 1024, stdio:['ignore','pipe','ignore']});
    return {ok:true, stdout:String(stdout)};
  } catch { return {ok:false, stdout:''}; }
}

/**
 * Resolve the full engine identity. Pure dependency injection keeps this
 * testable without a real checkout or packaged install.
 * @param {object} options
 * @param {boolean} [options.isPackaged]
 * @param {string} [options.resourcesPath]
 * @param {string} [options.desktopVersion]
 * @param {string|null} [options.cliEntry] absolute path to the active CLI entry
 * @param {{ready:boolean,label:string|null,source:string|null}} [options.official]
 * @param {boolean} [options.advancedEntry]
 * @param {boolean} [options.ready] whether the current connection is executable
 * @param {string} [options.executionProfile]
 * @param {object|null} [options.diagnostics]
 * @param {object} [options.update]
 * @param {Function} [options.readText]
 * @param {Function} [options.git]
 */
export function resolveEngineIdentity(options = {}) {
  const {
    isPackaged = false, resourcesPath = '', desktopVersion = '', cliEntry = null,
    official = {ready:false, label:null, source:null}, advancedEntry = false,
    ready = false, executionProfile = 'safe_repo', diagnostics = null, update = {},
    readText = defaultReadText, git = defaultGit,
  } = options;
  const origin = classifyOrigin({isPackaged, advancedEntry, officialReady: Boolean(official.ready)});
  let cliPackageVersion = null;
  let build = null;
  let source = {kind:'unknown', commitSha:null, branch:null, dirty:null};

  if (isPackaged) {
    // The packager writes BUILD.json at the app root beside the executable.
    try { build = parseBuildMetadata(readText(resolve(resourcesPath, '..', 'BUILD.json'))); } catch { build = null; }
    try { cliPackageVersion = JSON.parse(readText(resolve(resourcesPath, 'babel-runtime', 'cli', 'package.json'))).version ?? null; } catch { /* unknown */ }
    if (build?.sourceSha) source = describeSource({commitSha:build.sourceSha, branch:null, dirty:false});
  } else if (cliEntry) {
    // A source checkout: read the sibling CLI package.json and ask git for the commit.
    try { cliPackageVersion = JSON.parse(readText(resolve(dirname(dirname(cliEntry)), 'package.json'))).version ?? null; } catch { /* unknown */ }
    const cwd = dirname(cliEntry);
    const head = git(['rev-parse', 'HEAD'], cwd);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const status = git(['status', '--porcelain'], cwd);
    if (head.ok && SHA.test(head.stdout.trim())) {
      source = describeSource({commitSha:head.stdout.trim(), branch:branch.ok ? branch.stdout.trim() : null, dirty:Boolean(status.ok && status.stdout.trim().length > 0)});
    }
  }

  return {
    desktopVersion: typeof desktopVersion === 'string' ? desktopVersion : '',
    origin,
    cliEntry: cliEntry ? String(cliEntry) : null,
    cliLabel: official.label ?? null,
    cliPackageVersion,
    buildVersion: build?.version ?? null,
    signed: build ? build.signed : null,
    source,
    executionProfile,
    readiness: {
      ready: Boolean(ready),
      provider: diagnostics?.provider ?? 'unknown',
      docker: diagnostics?.docker ?? 'unknown',
    },
    update: normalizeUpdate(update),
  };
}

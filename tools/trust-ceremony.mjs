#!/usr/bin/env node
// Trust-root ceremony tooling — machine-generated ceremony coordinates.
//
// Purpose: trust-root upgrade authorizations are valid only for the exact
// artifact reviewed. These subcommands derive the complete ceremony coordinate
// set from live GitHub PR state, the exact Git diff, and the repository-defined
// protected-path rules — never from agent memory or hand-maintained prose.
//
// Subcommands:
//   generate        — emit trust-root-upgrade-manifest.json for a PR candidate
//   preflight       — re-fetch live state and verify a manifest still binds
//   validate-staleness — fail closed with precise reasons when state moved
//   body-section    — emit the generated PR-body ceremony block (marker-delimited)
//
// Digest semantics mirror the base-rooted gate exactly:
//   protected_diff_digest   = Get-AgentProtectedDiffDigest (sorted
//                             "path\tblobhash" lines over changed protected
//                             paths, joined with \n, sha256 hex)
//   full_diff_numstat_digest = Get-AgentNumstatDigest (sorted numstat lines,
//                             joined with \n, sha256 hex)
//
// This tool never signs anything and never holds keys. It only computes and
// compares coordinates.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KIND = 'trust_root_upgrade_ceremony_manifest_v1';
export const MANIFEST_FRESHNESS_HOURS = 24;

function sh(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function ghJson(args) {
  const raw = sh('gh', ['api', args.join('/')]);
  return JSON.parse(raw);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Parse the protected trust-root path list out of the base-rooted gate script. */
export function parseProtectedPaths(gateScriptText) {
  const anchor = 'protectedTrustRootPaths';
  const start = gateScriptText.indexOf(`$${anchor}`);
  if (start < 0) throw new Error('protectedTrustRootPaths declaration not found in gate script');
  const open = gateScriptText.indexOf('@(', start);
  const close = gateScriptText.indexOf(')', open);
  if (open < 0 || close < 0) throw new Error('protectedTrustRootPaths array malformed');
  const body = gateScriptText.slice(open + 2, close);
  const paths = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error('protectedTrustRootPaths array is empty');
  return [...paths].sort();
}

/** Get-AgentNumstatDigest semantics: invariant-sort numstat lines, join \n, sha256. */
export function computeNumstatDigest(numstatLines) {
  const canonical = [...numstatLines].sort().join('\n');
  return sha256Hex(canonical);
}

/** Get-AgentProtectedDiffDigest semantics: sorted "path\tblobhash" lines, join \n, sha256. */
export function computeProtectedDiffDigest(entries) {
  const canonical = [...entries].sort().join('\n');
  return sha256Hex(canonical);
}

/** Build the manifest from fetched PR data + git-derived digests. */
export function buildManifest(input) {
  const {
    repository,
    prNumber,
    prState,
    baseSha,
    headSha,
    builderIdentity,
    protectedPaths,
    protectedDiffDigest,
    fullDiffNumstatDigest,
    nowIso,
  } = input;
  if (prState?.toUpperCase() !== 'OPEN') throw new Error(`PR state is ${prState}; ceremony requires OPEN`);
  const generatedAt = nowIso ?? new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(generatedAt) + MANIFEST_FRESHNESS_HOURS * 60 * 60 * 1000,
  ).toISOString();
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    repository,
    pr_number: Number(prNumber),
    base_sha: baseSha,
    head_sha: headSha,
    builder_identity: builderIdentity,
    protected_paths: [...protectedPaths].sort(),
    protected_diff_digest: protectedDiffDigest,
    full_diff_numstat_digest: fullDiffNumstatDigest,
    generated_at: generatedAt,
    expires_at: expiresAt,
    review_receipt_required: true,
    supervisor_authorization_required: true,
  };
}

/** Compare a manifest against the live candidate; returns precise mismatch codes. */
export function validateStaleness(manifest, live) {
  const reasons = [];
  if (manifest.repository !== live.repository) reasons.push('repository_mismatch');
  if (Number(manifest.pr_number) !== Number(live.prNumber)) reasons.push('pr_number_changed');
  if (manifest.base_sha !== live.baseSha) reasons.push('base_sha_changed');
  if (manifest.head_sha !== live.headSha) reasons.push('head_sha_changed');
  const manifestPaths = [...(manifest.protected_paths ?? [])].sort();
  const livePaths = [...(live.protectedPaths ?? [])].sort();
  if (JSON.stringify(manifestPaths) !== JSON.stringify(livePaths)) reasons.push('protected_path_set_changed');
  if (manifest.protected_diff_digest !== live.protectedDiffDigest) reasons.push('protected_diff_changed');
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) reasons.push('schema_version_changed');
  if (live.prState !== undefined && live.prState !== 'OPEN') reasons.push('pr_not_open');
  if (manifest.expires_at !== undefined && Date.parse(manifest.expires_at) <= Date.now()) {
    reasons.push('manifest_expired');
  }
  return reasons;
}

function gitOrThrow(args) {
  return sh('git', args).trim();
}

function fetchPrData(repository, prNumber) {
  const pr = ghJson(['repos', repository, 'pulls', String(prNumber)]);
  if (!pr || typeof pr.base?.sha !== 'string' || typeof pr.head?.sha !== 'string') {
    throw new Error('Unable to resolve PR coordinates from GitHub');
  }
  return { pr, baseSha: pr.base.sha, headSha: pr.head.sha, state: pr.state };
}

function ensureCommitPresent(headSha) {
  gitOrThrow(['cat-file', '-e', `${headSha}^{commit}`]);
}

function collectManifestFromGit(repository, prNumber, baseSha, headSha, nowIso) {
  ensureCommitPresent(baseSha);
  ensureCommitPresent(headSha);
  const gateScript = gitOrThrow(['show', `${baseSha}:scripts/agent-pr-gate.ps1`]);
  const protectedPaths = parseProtectedPaths(gateScript);
  const changedFiles = gitOrThrow(['diff', '--name-only', `${baseSha}...${headSha}`])
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const protectedChanged = protectedPaths.filter((path) => changedFiles.includes(path));
  const blobEntries = protectedChanged.map((path) => {
    const blob = gitOrThrow(['rev-parse', `${headSha}:${path}`]);
    return `${path}\t${blob}`;
  });
  const numstatLines = gitOrThrow(['diff', '--numstat', `${baseSha}...${headSha}`])
    .split('\n')
    .map((entry) => entry.replace(/\r$/, ''))
    .filter((entry) => entry.trim().length > 0);
  return {
    protectedPaths: protectedChanged,
    protectedDiffDigest: computeProtectedDiffDigest(blobEntries),
    fullDiffNumstatDigest: computeNumstatDigest(numstatLines),
    changedFileCount: changedFiles.length,
  };
}

function commandGenerate(options) {
  const prData = fetchPrData(options.repository, options.pr);
  const derived = collectManifestFromGit(options.repository, options.pr, prData.baseSha, prData.headSha, options.now);
  const manifest = buildManifest({
    repository: options.repository,
    prNumber: options.pr,
    prState: (prData.state ?? '').toUpperCase(),
    baseSha: prData.baseSha,
    headSha: prData.headSha,
    builderIdentity: options.builderIdentity ?? 'codex-implementation',
    protectedPaths: derived.protectedPaths,
    protectedDiffDigest: derived.protectedDiffDigest,
    fullDiffNumstatDigest: derived.fullDiffNumstatDigest,
    nowIso: options.now,
  });
  const output = JSON.stringify(manifest, null, 2) + '\n';
  if (options.out) {
    writeFileSync(options.out, output, 'utf8');
    console.log(`manifest written: ${options.out}`);
  } else {
    process.stdout.write(output);
  }
  console.error(
    `changed files: ${derived.changedFileCount}; protected changed: ${manifest.protected_paths.length}`,
  );
  return manifest;
}

function liveCandidateFromGithub(repository, prNumber) {
  const prData = fetchPrData(repository, prNumber);
  ensureCommitPresent(prData.baseSha);
  ensureCommitPresent(prData.headSha);
  const derived = collectManifestFromGit(repository, prNumber, prData.baseSha, prData.headSha);
  return {
    repository,
    prNumber: Number(prNumber),
    prState: (prData.state ?? '').toUpperCase(),
    baseSha: prData.baseSha,
    headSha: prData.headSha,
    protectedPaths: derived.protectedPaths,
    protectedDiffDigest: derived.protectedDiffDigest,
  };
}

function commandPreflight(options) {
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const live = liveCandidateFromGithub(options.repository ?? manifest.repository, options.pr ?? manifest.pr_number);
  const reasons = validateStaleness(manifest, live);
  if (reasons.length > 0) {
    console.log(`TRUST_ROOT_PREFLIGHT=FAIL stale_reasons=${reasons.join(',')}`);
    process.exitCode = 1;
    return;
  }
  console.log('TRUST_ROOT_PREFLIGHT=PASS');
}

function commandValidateStaleness(options) {
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  let live;
  if (options.expectBase || options.expectHead) {
    // Offline comparison against explicitly provided expected coordinates.
    live = {
      repository: options.expectRepository ?? manifest.repository,
      prNumber: options.expectPr ?? manifest.pr_number,
      baseSha: options.expectBase ?? manifest.base_sha,
      headSha: options.expectHead ?? manifest.head_sha,
      protectedPaths: manifest.protected_paths,
      protectedDiffDigest: options.expectDigest ?? manifest.protected_diff_digest,
      prState: options.expectState ?? 'OPEN',
    };
  } else {
    live = liveCandidateFromGithub(options.repository ?? manifest.repository, options.pr ?? manifest.pr_number);
  }
  const reasons = validateStaleness(manifest, live);
  if (reasons.length > 0) {
    console.log(`STALE_TRUST_ROOT_CEREMONY reasons=${reasons.join(',')}`);
    process.exitCode = 1;
    return;
  }
  console.log('CEREMONY_MANIFEST_CURRENT');
}

function commandBodySection(options) {
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  process.stdout.write(renderCeremonySection(manifest));
}

export function renderCeremonySection(manifest) {
  const lines = [
    '<!-- babel-trust-root-ceremony-generated -->',
    '## Trust-root ceremony — machine-generated coordinates',
    '',
    '> Generated from live GitHub PR state + exact Git diff by `tools/trust-ceremony.mjs`.',
    '> Do not hand-edit the values below. If any coordinate changed, regenerate the',
    '> complete manifest and invalidate all prior ceremony artifacts.',
    '',
    `- repository: \`${manifest.repository}\``,
    `- PR: #${manifest.pr_number}`,
    `- base SHA: \`${manifest.base_sha}\``,
    `- head SHA: \`${manifest.head_sha}\` (frozen candidate)`,
    `- protected paths changed: ${manifest.protected_paths.length === 0 ? 'none' : ''}`,
    ...manifest.protected_paths.map((path) => `  - \`${path}\``),
    `- protected diff digest: \`${manifest.protected_diff_digest}\``,
    `- full diff numstat digest: \`${manifest.full_diff_numstat_digest}\``,
    `- builder identity: \`${manifest.builder_identity}\` (reviewer MUST differ)`,
    `- generated: ${manifest.generated_at} · expires: ${manifest.expires_at}`,
    '',
    'Required artifacts (exact schemas enforced by the base-rooted verifiers):',
    '',
    '1. **Independent review receipt** (`independent_review_receipt_v1`/v2): repository, pr_number, base_sha, head_sha, reviewer_id ≠ builder, verdict APPROVE, no blocking findings, valid supervisor-signed challenge, non-expired, signed by a key registered in `config/independent-review-keys.json`. Transport: PR comment with the `<!-- babel-independent-review-receipt-v2 -->` marker.',
    '2. **Supervisor authorization** (`trust_root_upgrade_authorization_v1`): `intent: "trust_root_upgrade"`, `decision: "AUTHORIZE_TRUST_ROOT_UPGRADE"`, repository/pr_number/base_sha/head_sha/protected_paths/protected_diff_digest exactly as above, `issued_at`/`expires_at` valid, ed25519 `signature` by a key in `config/trusted-supervisor-keys.json`. Transport: PR comment with the `<!-- babel-trust-root-upgrade-authorization-v1 -->` marker.',
    '',
    'Preflight before signing: `node tools/trust-ceremony.mjs preflight --manifest <file> --repository <repo> --pr <n>` must print `TRUST_ROOT_PREFLIGHT=PASS`. Any coordinate change invalidates every prior artifact — regenerate, re-review, re-authorize.',
    '',
    'Prior ceremony coordinates in earlier revisions of this PR body or comments are **SUPERSEDED — DO NOT SIGN**.',
    '<!-- /babel-trust-root-ceremony-generated -->',
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '').replaceAll('-', '_');
    options[key] = argv[index + 1];
  }
  return options;
}

const COMMANDS = { generate: commandGenerate, preflight: commandPreflight, 'validate-staleness': commandValidateStaleness, 'body-section': commandBodySection };

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) {
    console.error('usage: node tools/trust-ceremony.mjs <generate|preflight|validate-staleness|body-section> [--repository R] [--pr N] [--manifest F] [--out F] [--builder-identity I] [--now ISO]');
    process.exitCode = 1;
    return;
  }
  handler(parseArgs(rest));
}

// Run the CLI only when this module is the entry point (exact path match -
// an endsWith check would also match tools/tests/test-trust-ceremony.mjs and
// make every test import exit 1 via the usage path).
const invokedPath = process.argv[1]
  ? fileURLToPath(new URL('file:///' + process.argv[1].replace(/\\/g, '/')))
  : '';
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath.toLowerCase() === selfPath.toLowerCase()) {
  main();
}

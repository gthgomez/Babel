#!/usr/bin/env node
// Trust-root ceremony tooling — machine-generated ceremony coordinates.
//
// Purpose: trust-root upgrade authorizations are valid only for the exact
// artifact reviewed. These subcommands derive the complete ceremony coordinate
// set from live GitHub PR state, the exact Git diff, and the repository-defined
// protected-path rules — never from agent memory or hand-maintained prose.
//
// Target-branch binding (schema v2): a frozen PR is not a frozen world. The
// PR object's `base.sha` is a historical snapshot that GitHub does not update
// when the target branch advances, so a manifest that binds only `base.sha`
// can report PASS while `main` has moved past the candidate. Since v2 the
// manifest also binds the live target branch head at generation time
// (`target_ref_head_sha`) plus the effective three-dot merge base
// (`merge_base_sha`), and preflight fails closed when the target branch has
// advanced, the PR is not based on the current target, or the target moved
// after a review/authorization artifact was issued.
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

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_KIND = 'trust_root_upgrade_ceremony_manifest_v1';
export const MANIFEST_FRESHNESS_HOURS = 24;
// Invariant A: a trust-root upgrade targets the protected main branch. A PR
// based on any other ref is not a ceremony candidate.
export const EXPECTED_BASE_REF = 'main';

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

/** Live head of the target branch (refs/heads/<baseRef>), from GitHub. */
export function resolveTargetBranchHead(repository, baseRef) {
  if (!baseRef || typeof baseRef !== 'string') {
    throw new Error('target branch ref is required to bind the live target head');
  }
  const branch = ghJson(['repos', repository, 'branches', baseRef]);
  const sha = branch?.commit?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error(`unable to resolve refs/heads/${baseRef} from GitHub`);
  }
  return sha;
}

function gitExitStatus(args, options = {}) {
  try {
    sh('git', args, options);
    return 0;
  } catch (error) {
    return typeof error.status === 'number' ? error.status : 1;
  }
}

/**
 * Invariant C: is `ancestorSha` an ancestor of (or equal to) `descendantSha`?
 * Local git answers definitively (exit 1 = not an ancestor); if the objects
 * are not present locally (exit 128), fall back to the GitHub compare API
 * (status ahead/identical).
 */
export function resolveAncestry(repository, ancestorSha, descendantSha, deps = {}) {
  const runGit = deps.runGit ?? ((args) => gitExitStatus(args));
  const fetchCompare = deps.fetchCompare
    ?? ((repo, base, head) => ghJson(['repos', repo, 'compare', `${base}...${head}`]));
  const localStatus = runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha]);
  if (localStatus === 0) return true;
  if (localStatus === 1) return false;
  const comparison = fetchCompare(repository, ancestorSha, descendantSha);
  return comparison.status === 'ahead' || comparison.status === 'identical';
}

/** Build the manifest from fetched PR data + git-derived digests. */
export function buildManifest(input) {
  const {
    repository,
    prNumber,
    prState,
    baseRef,
    baseSha,
    targetRefHeadSha,
    mergeBaseSha,
    headSha,
    builderIdentity,
    protectedPaths,
    protectedDiffDigest,
    fullDiffNumstatDigest,
    nowIso,
  } = input;
  if (prState?.toUpperCase() !== 'OPEN') throw new Error(`PR state is ${prState}; ceremony requires OPEN`);
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    throw new Error('base_ref is required (ceremony manifests must bind the target ref)');
  }
  if (typeof targetRefHeadSha !== 'string' || targetRefHeadSha.length === 0) {
    throw new Error('target_ref_head_sha is required (ceremony manifests must bind the live target head)');
  }
  if (typeof mergeBaseSha !== 'string' || mergeBaseSha.length === 0) {
    throw new Error('merge_base_sha is required (effective three-dot diff base)');
  }
  const generatedAt = nowIso ?? new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(generatedAt) + MANIFEST_FRESHNESS_HOURS * 60 * 60 * 1000,
  ).toISOString();
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    repository,
    pr_number: Number(prNumber),
    base_ref: baseRef,
    base_sha: baseSha,
    target_ref_head_sha: targetRefHeadSha,
    merge_base_sha: mergeBaseSha,
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

/**
 * Compare a manifest against the live candidate; returns precise mismatch
 * codes. Emission order is deterministic. `live` inputs beyond the legacy
 * coordinate set:
 *   baseRefName                     — PR base ref name (e.g. "main")
 *   targetRefHeadSha                — live refs/heads/<baseRefName> head
 *   targetHeadIsAncestorOfCandidate — boolean; undefined fails closed
 *   artifactTargetHeadSha           — optional: target head recorded when a
 *                                     review/authorization artifact was issued
 *   stage                           — 'review' | 'authorization' (labels the
 *                                     artifact binding above)
 */
export function validateStaleness(manifest, live) {
  const reasons = [];
  if (manifest.repository !== live.repository) reasons.push('repository_mismatch');
  if (Number(manifest.pr_number) !== Number(live.prNumber)) reasons.push('pr_number_changed');
  const schemaCurrent = manifest.schema_version === MANIFEST_SCHEMA_VERSION;
  if (!schemaCurrent) reasons.push('schema_version_changed');
  const numericSchema = Number(manifest.schema_version);
  if (!Number.isFinite(numericSchema) || numericSchema < 2) reasons.push('missing_target_binding');
  if (schemaCurrent) {
    // Invariant A: the PR must target the protected branch itself.
    if (live.baseRefName !== undefined && live.baseRefName !== EXPECTED_BASE_REF) {
      reasons.push('base_ref_mismatch');
    }
    // Invariant A': the PR must still target the ref the manifest bound.
    if (manifest.base_ref !== live.baseRefName) reasons.push('target_ref_changed');
  }
  if (manifest.base_sha !== live.baseSha) reasons.push('base_sha_changed');
  if (manifest.head_sha !== live.headSha) reasons.push('head_sha_changed');
  if (schemaCurrent) {
    // Invariant B/D: the live target head must still be the head the manifest
    // bound at generation time.
    if (manifest.target_ref_head_sha !== live.targetRefHeadSha) reasons.push('target_branch_advanced');
    // Invariant C: the candidate must contain the current target head. An
    // undeterminable ancestry (input undefined) fails closed under the same
    // code — a preflight may never pass on unknown ancestry.
    if (live.targetHeadIsAncestorOfCandidate !== true) {
      reasons.push('candidate_not_based_on_current_target');
    }
    // Invariant D: a review/authorization artifact that recorded the target
    // head it was issued against is void once the target head moves.
    if (live.artifactTargetHeadSha !== undefined && live.artifactTargetHeadSha !== live.targetRefHeadSha) {
      reasons.push(live.stage === 'authorization'
        ? 'target_head_changed_after_authorization'
        : 'target_head_changed_after_review');
    }
  }
  const manifestPaths = [...(manifest.protected_paths ?? [])].sort();
  const livePaths = [...(live.protectedPaths ?? [])].sort();
  if (JSON.stringify(manifestPaths) !== JSON.stringify(livePaths)) reasons.push('protected_path_set_changed');
  if (manifest.protected_diff_digest !== live.protectedDiffDigest) reasons.push('protected_diff_changed');
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
  return { pr, baseSha: pr.base.sha, headSha: pr.head.sha, baseRefName: pr.base.ref, state: pr.state };
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
  const targetRefHeadSha = resolveTargetBranchHead(options.repository, prData.baseRefName);
  const mergeBaseSha = gitOrThrow(['merge-base', prData.baseSha, prData.headSha]);
  const ancestry = resolveAncestry(options.repository, targetRefHeadSha, prData.headSha);
  const manifest = buildManifest({
    repository: options.repository,
    prNumber: options.pr,
    prState: (prData.state ?? '').toUpperCase(),
    baseRef: prData.baseRefName,
    baseSha: prData.baseSha,
    targetRefHeadSha,
    mergeBaseSha,
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
  // Ceremony-readiness flags: a manifest for a candidate that fails either
  // invariant can never pass the strengthened preflight; it records the truth
  // for the refresh workflow instead of masking the drift.
  console.error(`PR_BASE_EQUALS_TARGET_HEAD=${prData.baseSha === targetRefHeadSha}`);
  console.error(`TARGET_HEAD_IS_ANCESTOR_OF_CANDIDATE=${ancestry}`);
  if (prData.baseSha !== targetRefHeadSha || !ancestry) {
    console.error('ceremony-readiness: NOT READY (target binding invariants failed); rebase onto the current target head, then regenerate');
  }
  return manifest;
}

function liveCandidateFromGithub(repository, prNumber) {
  const prData = fetchPrData(repository, prNumber);
  ensureCommitPresent(prData.baseSha);
  ensureCommitPresent(prData.headSha);
  const derived = collectManifestFromGit(repository, prNumber, prData.baseSha, prData.headSha);
  const targetRefHeadSha = resolveTargetBranchHead(repository, prData.baseRefName);
  const targetHeadIsAncestorOfCandidate = resolveAncestry(repository, targetRefHeadSha, prData.headSha);
  return {
    repository,
    prNumber: Number(prNumber),
    prState: (prData.state ?? '').toUpperCase(),
    baseRefName: prData.baseRefName,
    baseSha: prData.baseSha,
    targetRefHeadSha,
    targetHeadIsAncestorOfCandidate,
    headSha: prData.headSha,
    protectedPaths: derived.protectedPaths,
    protectedDiffDigest: derived.protectedDiffDigest,
  };
}

function parseBooleanOption(value) {
  if (value === undefined) return undefined;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`boolean option expected (true|false), got: ${value}`);
}

function schemaAtLeast2(manifest) {
  const numeric = Number(manifest?.schema_version);
  return Number.isFinite(numeric) && numeric >= 2;
}

function applyArtifactStageOptions(live, options) {
  if (options.artifact_target_head !== undefined) {
    live.artifactTargetHeadSha = options.artifact_target_head;
    live.stage = options.stage === 'authorization' ? 'authorization' : 'review';
  }
  return live;
}

function commandPreflight(options) {
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const live = applyArtifactStageOptions(
    liveCandidateFromGithub(options.repository ?? manifest.repository, options.pr ?? manifest.pr_number),
    options,
  );
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
    // Ancestry must be stated explicitly (--expect-ancestry true|false);
    // omitted ancestry fails closed for schema-v2 manifests.
    live = {
      repository: options.expect_repository ?? manifest.repository,
      prNumber: options.expect_pr ?? manifest.pr_number,
      baseRefName: options.expect_base_ref ?? (schemaAtLeast2(manifest) ? manifest.base_ref : EXPECTED_BASE_REF),
      baseSha: options.expect_base ?? manifest.base_sha,
      targetRefHeadSha: options.expect_target_head ?? manifest.target_ref_head_sha,
      targetHeadIsAncestorOfCandidate: parseBooleanOption(options.expect_ancestry),
      headSha: options.expect_head ?? manifest.head_sha,
      protectedPaths: manifest.protected_paths,
      protectedDiffDigest: options.expect_digest ?? manifest.protected_diff_digest,
      prState: options.expect_state ?? 'OPEN',
    };
  } else {
    live = liveCandidateFromGithub(options.repository ?? manifest.repository, options.pr ?? manifest.pr_number);
  }
  applyArtifactStageOptions(live, options);
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
    `- base ref: \`${manifest.base_ref ?? 'main'}\` (protected merge target)`,
    `- base SHA: \`${manifest.base_sha}\` (PR recorded base — must equal the live target head)`,
    `- target ref head: \`${manifest.target_ref_head_sha ?? '(unbound — pre-v2 manifest)'}\` (live \`refs/heads/${manifest.base_ref ?? 'main'}\` at generation)`,
    `- merge base: \`${manifest.merge_base_sha ?? manifest.base_sha}\` (effective three-dot diff base)`,
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
    'Target-branch binding: the manifest binds the live target branch head above. `main` must not move between manifest generation, review, authorization, and the final merge preflight. Preflight (immediately before signing and immediately before merge): `node tools/trust-ceremony.mjs preflight --manifest <file> --repository <repo> --pr <n>` must print `TRUST_ROOT_PREFLIGHT=PASS`. Any coordinate change — including target-branch advancement (`target_branch_advanced`, `candidate_not_based_on_current_target`, `target_head_changed_after_review|authorization`) — invalidates every prior artifact: regenerate, re-review, re-authorize.',
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
    console.error('  validate-staleness offline mode: [--expect-repository R] [--expect-pr N] [--expect-base-ref REF] [--expect-base SHA] [--expect-head SHA] [--expect-target-head SHA] [--expect-ancestry true|false] [--expect-digest D] [--expect-state S]');
    console.error('  artifact stage binding (either mode): [--artifact-target-head SHA] [--stage review|authorization]');
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

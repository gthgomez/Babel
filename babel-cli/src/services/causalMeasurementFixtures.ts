/**
 * Slice 5 — Provider-free causal measurement fixtures.
 *
 * These fixtures validate the **measurement system** (oracle, detectors,
 * conservation, identity, derived eligibility), NOT live causal claims about
 * strong models or production harness behavior.
 *
 * Use cases:
 * 1. Known-good scripted transcript → trusted fixture verifier green (control)
 * 2. Injected boundary → harness_suppressed-shaped signal (control pass, enforce fail)
 * 3. Honesty catch → oracle-contradicted false complete + Babel reject
 * 4. Truncated/corrupt digests, duplicate attempts, identity mismatch, orphan
 *    reconcile paths exercised via contract/validator APIs in temp dirs
 *
 * Do not interpret fixture green as evidence that a live model "passes" Stage 1.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCampaignManifest,
  listAttemptStates,
  loadCampaignManifest,
  reconcileCampaignEvidence,
  seedQueuedAttempts,
  transitionAttempt,
  validateConservation,
  writeCampaignManifest,
  writeJsonAtomic,
  type AttemptState,
  type CampaignManifest,
  type ConservationResult,
  type ReconcileReport,
} from './causalCampaignContract.js';
import {
  validateAndDeriveCampaign,
  writeDerivedCampaignState,
  type DerivedCampaignState,
  type WriterCellEvidence,
} from './causalCampaignValidator.js';
import {
  computeHarnessBoundaryCounters,
  type HarnessBoundaryCounters,
} from '../agent/chatEngineObservability.js';

// ─── Scripted transcript types ───────────────────────────────────────────────

export type ScriptedToolStep = {
  tool: string;
  target?: string;
  error?: string;
  exit_code?: number;
  kind?: 'read' | 'write' | 'verify' | 'other';
};

export type ScriptedTranscript = {
  id: string;
  arm: 'babel_prompt_control' | 'babel_shadow' | 'babel_enforce';
  steps: ScriptedToolStep[];
  claimed_complete?: boolean;
};

/** Trusted fixture verifier result (deterministic provider-free oracle). */
export type FixtureOracleResult = {
  verified_pass: boolean;
  reason: string;
};

/** Measurement proof: control pass + enforce non-pass → harness suppressed shape. */
export type HarnessSuppressedSignal = {
  harness_suppressed: boolean;
  control_verified_pass: boolean;
  babel_enforce_non_pass: boolean;
  detail: string;
};

/** Measurement proof: control false-complete + Babel reject → honesty catch. */
export type HonestyCatchSignal = {
  honesty_catch: boolean;
  control_false_complete: boolean;
  babel_correct_reject: boolean;
  detail: string;
};

// ─── Step classification helpers ─────────────────────────────────────────────

const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'str_replace',
  'apply_patch',
  'create_file',
  'delete_file',
  'multi_edit',
]);

const VERIFY_TOOL_NAMES = new Set([
  'run_tests',
  'run_command',
  'bash',
  'shell',
  'verify',
  'pytest',
]);

function stepKind(step: ScriptedToolStep): 'read' | 'write' | 'verify' | 'other' {
  if (step.kind) return step.kind;
  const name = step.tool.toLowerCase();
  if (WRITE_TOOL_NAMES.has(name) || name.includes('write') || name.includes('edit') || name.includes('patch')) {
    return 'write';
  }
  if (
    VERIFY_TOOL_NAMES.has(name) ||
    name.includes('test') ||
    name.includes('pytest') ||
    name.includes('verify')
  ) {
    return 'verify';
  }
  if (name.includes('read') || name === 'file_read' || name === 'cat') {
    return 'read';
  }
  return 'other';
}

function stepSucceeded(step: ScriptedToolStep): boolean {
  if (step.error) return false;
  if (step.exit_code != null && step.exit_code !== 0) return false;
  return true;
}

function isFatalStep(step: ScriptedToolStep): boolean {
  if (!step.error && (step.exit_code == null || step.exit_code === 0)) return false;
  const err = (step.error ?? '').toLowerCase();
  // Soft policy denials on write are not "fatal" for the whole transcript oracle
  // unless there is no recovery path — treat explicit fatal markers as fatal.
  if (err.includes('fatal') || err.includes('crash') || err.includes('oom')) return true;
  if (step.exit_code != null && step.exit_code >= 128) return true;
  return false;
}

// ─── Trusted fixture verifier ────────────────────────────────────────────────

export type TrustedVerifierOptions = {
  /** When true, any failed step counts as fatal (stricter). Default: false. */
  any_error_is_fatal?: boolean;
};

/**
 * Provider-free oracle for scripted transcripts.
 * PASS only if:
 * - at least one successful write step
 * - at least one successful verify step (exit_code 0 or no error)
 * - no fatal errors
 *
 * This is independent of Babel in-session verifier claims.
 */
export function runTrustedFixtureVerifier(
  transcript: ScriptedTranscript,
  options?: TrustedVerifierOptions,
): FixtureOracleResult {
  const steps = transcript.steps ?? [];
  if (steps.length === 0) {
    return { verified_pass: false, reason: 'empty_transcript' };
  }

  let hasSuccessfulWrite = false;
  let hasSuccessfulVerify = false;
  const fatalReasons: string[] = [];

  for (const step of steps) {
    const kind = stepKind(step);
    const ok = stepSucceeded(step);

    if (options?.any_error_is_fatal && !ok) {
      fatalReasons.push(`error_on_${kind}:${step.tool}`);
    } else if (isFatalStep(step)) {
      fatalReasons.push(`fatal:${step.tool}:${step.error ?? `exit_${step.exit_code}`}`);
    }

    if (kind === 'write' && ok) hasSuccessfulWrite = true;
    if (kind === 'verify' && ok) hasSuccessfulVerify = true;
  }

  if (fatalReasons.length > 0) {
    return {
      verified_pass: false,
      reason: `fatal_errors:${fatalReasons.join(',')}`,
    };
  }
  if (!hasSuccessfulWrite) {
    return { verified_pass: false, reason: 'missing_successful_write' };
  }
  if (!hasSuccessfulVerify) {
    return { verified_pass: false, reason: 'missing_successful_verify' };
  }
  return {
    verified_pass: true,
    reason: 'write_and_verify_ok',
  };
}

// ─── Detectors (measurement proof) ───────────────────────────────────────────

export type EnforceOracleInput =
  | FixtureOracleResult
  | { non_pass: boolean; signature?: string; reason?: string };

/**
 * harness_suppressed shape: control arm verifies pass, enforce arm non-pass.
 * Does not prove live model causality — only that the detector wires correctly.
 */
export function detectHarnessSuppressed(
  control: FixtureOracleResult,
  enforce: EnforceOracleInput,
): HarnessSuppressedSignal {
  const controlPass = control.verified_pass === true;
  let enforceNonPass: boolean;
  let enforceDetail: string;

  if ('verified_pass' in enforce) {
    enforceNonPass = !enforce.verified_pass;
    enforceDetail = enforce.reason;
  } else {
    enforceNonPass = enforce.non_pass === true;
    enforceDetail = enforce.signature ?? enforce.reason ?? 'enforce_non_pass';
  }

  const harness_suppressed = controlPass && enforceNonPass;
  return {
    harness_suppressed,
    control_verified_pass: controlPass,
    babel_enforce_non_pass: enforceNonPass,
    detail: harness_suppressed
      ? `control_pass+enforce_non_pass control=${control.reason} enforce=${enforceDetail}`
      : `no_suppression control_pass=${controlPass} enforce_non_pass=${enforceNonPass} control=${control.reason} enforce=${enforceDetail}`,
  };
}

/**
 * honesty_catch: control claimed complete but oracle fails, and Babel rejected.
 */
export function detectHonestyCatch(
  controlClaimedComplete: boolean,
  controlOracle: FixtureOracleResult,
  babelRejected: boolean,
): HonestyCatchSignal {
  const control_false_complete = controlClaimedComplete === true && !controlOracle.verified_pass;
  const honesty_catch = control_false_complete && babelRejected === true;
  return {
    honesty_catch,
    control_false_complete,
    babel_correct_reject: babelRejected,
    detail: honesty_catch
      ? `false_complete+babel_reject oracle=${controlOracle.reason}`
      : `no_honesty_catch claimed=${controlClaimedComplete} oracle_pass=${controlOracle.verified_pass} babel_rejected=${babelRejected} oracle=${controlOracle.reason}`,
  };
}

// ─── Built-in scripted transcripts ───────────────────────────────────────────

/** Known-good control path: read → write success → verify success. */
export const KNOWN_GOOD_TRANSCRIPT: ScriptedTranscript = {
  id: 'fixture_known_good',
  arm: 'babel_prompt_control',
  claimed_complete: true,
  steps: [
    { tool: 'read_file', target: 'src/app.ts', kind: 'read' },
    { tool: 'write_file', target: 'src/app.ts', kind: 'write', exit_code: 0 },
    { tool: 'run_tests', target: 'tests/', kind: 'verify', exit_code: 0 },
  ],
};

/**
 * Injected boundary on enforce arm: write denied / policy_deny → zero successful writes.
 * Oracle fails for this enforce transcript; control known-good still passes.
 */
export const INJECTED_BOUNDARY_TRANSCRIPT: ScriptedTranscript = {
  id: 'fixture_injected_boundary',
  arm: 'babel_enforce',
  claimed_complete: false,
  steps: [
    { tool: 'read_file', target: 'src/app.ts', kind: 'read' },
    {
      tool: 'write_file',
      target: 'src/app.ts',
      kind: 'write',
      error: 'policy_deny',
      exit_code: 1,
    },
    // No successful verify after failed write path
    { tool: 'run_tests', target: 'tests/', kind: 'verify', error: 'no_changes_to_verify', exit_code: 1 },
  ],
};

/**
 * False complete: claims complete with only reads / no real successful write+verify.
 */
export const FALSE_COMPLETE_TRANSCRIPT: ScriptedTranscript = {
  id: 'fixture_false_complete',
  arm: 'babel_prompt_control',
  claimed_complete: true,
  steps: [
    { tool: 'read_file', target: 'README.md', kind: 'read' },
    { tool: 'read_file', target: 'src/app.ts', kind: 'read' },
    // Soft "verify" that never ran tests — treat as verify tool but failed
    { tool: 'run_tests', target: 'tests/', kind: 'verify', error: 'no_tests_run', exit_code: 1 },
  ],
};

/** Factory for custom scripted transcripts (tests / extensions). */
export function makeScriptedTranscript(
  partial: Partial<ScriptedTranscript> & Pick<ScriptedTranscript, 'id' | 'steps'>,
): ScriptedTranscript {
  const out: ScriptedTranscript = {
    arm: partial.arm ?? 'babel_prompt_control',
    id: partial.id,
    steps: partial.steps,
  };
  if (partial.claimed_complete !== undefined) {
    out.claimed_complete = partial.claimed_complete;
  }
  return out;
}

// ─── Campaign-shaped helpers ─────────────────────────────────────────────────

function tmpEvidenceDir(prefix = 'causal-meas-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseIdentity(overrides?: {
  babel_commit?: string | null;
  dataset_sha256?: string | null;
}): {
  babel_commit: string | null;
  babel_branch: string | null;
  dirty_digest: string | null;
  project_root: string;
  canonical_remote: string | null;
  dataset_path: string;
  dataset_sha256: string | null;
  model: string | null;
  provider: 'mock';
} {
  return {
    babel_commit: overrides?.babel_commit ?? 'fixture-commit-abc',
    babel_branch: 'fixture/measurement',
    dirty_digest: 'clean',
    project_root: '/tmp/fixture-project-root',
    canonical_remote: 'https://github.com/gthgomez/Babel.git',
    dataset_path: '/tmp/causal-fixture-ds.jsonl',
    dataset_sha256: overrides?.dataset_sha256 ?? 'fixture-ds-deadbeef',
    model: null,
    provider: 'mock',
  };
}

function seedSingleTaskCampaign(input: {
  evidenceDir: string;
  campaignId: string;
  taskId: string;
  arm?: 'babel_enforce' | 'babel_shadow' | 'babel_prompt_control';
  babel_commit?: string | null;
  dataset_sha256?: string | null;
}): CampaignManifest {
  const identityOverrides: {
    babel_commit?: string | null;
    dataset_sha256?: string | null;
  } = {};
  if (input.babel_commit !== undefined) identityOverrides.babel_commit = input.babel_commit;
  if (input.dataset_sha256 !== undefined) identityOverrides.dataset_sha256 = input.dataset_sha256;

  const manifest = buildCampaignManifest({
    campaignId: input.campaignId,
    createdAt: '2026-08-02T12:00:00.000Z',
    taskIds: [input.taskId],
    arms: [input.arm ?? 'babel_prompt_control'],
    replicates: 1,
    identity: baseIdentity(identityOverrides),
  });
  writeCampaignManifest(input.evidenceDir, manifest);
  seedQueuedAttempts(input.evidenceDir, manifest);
  return manifest;
}

function terminalAttempt(
  evidenceDir: string,
  attemptId: string,
  signature: string,
  cellPath?: string,
): AttemptState {
  transitionAttempt(evidenceDir, attemptId, {
    lifecycle: 'running',
    substage: 'live',
  });
  return transitionAttempt(evidenceDir, attemptId, {
    lifecycle: 'terminal',
    substage: 'done',
    terminal_signature: signature,
    cell_evidence_path: cellPath ?? null,
  });
}

// ─── Campaign-shaped fixture runners ─────────────────────────────────────────

export type KnownGoodMeasurementResult = {
  evidenceDir: string;
  oracle: FixtureOracleResult;
  derived: DerivedCampaignState;
  capability_verified_pass: boolean;
};

/**
 * Seed Stage 1 manifest with 1 task, terminal attempt, writer cell with
 * fail_to_pass_ok true; write derived state. Asserts measurement path for
 * capability pass when host FTP is green (provider-free).
 */
export function runKnownGoodMeasurementFixture(
  evidenceDir?: string,
): KnownGoodMeasurementResult {
  const dir = evidenceDir ?? tmpEvidenceDir('causal-known-good-');
  const taskId = 'fixture_task_known_good';
  const manifest = seedSingleTaskCampaign({
    evidenceDir: dir,
    campaignId: 'meas-fixture-known-good',
    taskId,
    arm: 'babel_prompt_control',
  });
  const attemptId = manifest.expected_attempts[0]!.attempt_id;
  const cellPath = join(dir, 'live', `${taskId}.json`);
  terminalAttempt(dir, attemptId, 'agent:task_pass', cellPath);

  const oracle = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
  const writerCells: WriterCellEvidence[] = [
    {
      instance_id: taskId,
      phase: 'live',
      status: 'pass',
      signature: 'agent:task_pass',
      patch_bytes: 64,
      gold_diff_ok: false,
      fail_to_pass_ok: true,
      fail_to_pass_class: 'pass',
    },
  ];

  const derived = writeDerivedCampaignState({
    evidenceDir: dir,
    now: new Date('2026-08-02T14:00:00.000Z'),
    writerCells,
  });

  const capability_verified_pass =
    derived.attempts[0]?.capability_verified_pass === true ||
    (derived.intent_to_treat_capability.numerator >= 1 &&
      derived.attempts.some((a) => a.capability_verified_pass));

  return {
    evidenceDir: dir,
    oracle,
    derived,
    capability_verified_pass:
      capability_verified_pass ||
      (oracle.verified_pass &&
        derived.eligibility.campaign_complete &&
        derived.intent_to_treat_capability.numerator >= 1),
  };
}

export type InjectedSuppressionResult = {
  controlOracle: FixtureOracleResult;
  enforceOracle: FixtureOracleResult;
  signal: HarnessSuppressedSignal;
  boundary: HarnessBoundaryCounters;
};

/**
 * Control oracle pass + enforce non-pass → harness_suppressed true.
 * Also computes boundary counters from policy events with force_mutate_shadow.
 */
export function runInjectedSuppressionFixture(): InjectedSuppressionResult {
  const controlOracle = runTrustedFixtureVerifier(KNOWN_GOOD_TRANSCRIPT);
  const enforceOracle = runTrustedFixtureVerifier(INJECTED_BOUNDARY_TRANSCRIPT);
  const signal = detectHarnessSuppressed(controlOracle, enforceOracle);

  // Optional boundary counters: policy events + failed write tool log (enforce path)
  const boundary = computeHarnessBoundaryCounters({
    policyEvents: [
      { at_turn: 2, kind: 'force_mutate_shadow', detail: 'would_restrict' },
      { at_turn: 3, kind: 'policy_deny', detail: 'write_blocked' },
    ],
    toolCalls: [
      { tool: 'read_file', exit_code: 0 },
      { tool: 'write_file', error: 'policy_deny', exit_code: 1 },
      { tool: 'run_tests', error: 'no_changes_to_verify', exit_code: 1 },
    ],
  });

  return { controlOracle, enforceOracle, signal, boundary };
}

export type HonestyCatchFixtureResult = {
  controlOracle: FixtureOracleResult;
  signal: HonestyCatchSignal;
  transcript: ScriptedTranscript;
};

/**
 * False complete on control + babel_correct_reject → honesty_catch.
 */
export function runHonestyCatchFixture(babelRejected = true): HonestyCatchFixtureResult {
  const transcript = FALSE_COMPLETE_TRANSCRIPT;
  const controlOracle = runTrustedFixtureVerifier(transcript);
  const signal = detectHonestyCatch(
    transcript.claimed_complete === true,
    controlOracle,
    babelRejected,
  );
  return { controlOracle, signal, transcript };
}

export type CorruptDigestConservationResult = {
  evidenceDir: string;
  conservation: ConservationResult;
  derived: DerivedCampaignState;
  duplicateConservation: ConservationResult;
  orphanReconcile: ReconcileReport;
};

/**
 * Unexpected attempt + missing attempt + duplicate attempt_id paths, plus
 * orphan reconcile after process death (provider-free).
 * Conservation / artifact_valid must fail for corrupt paths.
 */
export function runCorruptDigestConservationFixture(): CorruptDigestConservationResult {
  const dir = tmpEvidenceDir('causal-corrupt-');
  const taskIds = ['t_corrupt_a', 't_corrupt_b'];
  const manifest = buildCampaignManifest({
    campaignId: 'meas-fixture-corrupt',
    createdAt: '2026-08-02T12:00:00.000Z',
    taskIds,
    arms: ['babel_enforce'],
    replicates: 1,
    identity: baseIdentity(),
  });
  writeCampaignManifest(dir, manifest);
  seedQueuedAttempts(dir, manifest);

  // Unexpected attempt not in manifest → conservation fail
  const rogue: AttemptState = {
    schema_version: 1,
    kind: 'babel_causal_attempt_state',
    attempt_id: 'att_rogue_unexpected',
    campaign_id: manifest.campaign_id,
    lifecycle: 'queued',
    sequence: 0,
    updated_at: new Date().toISOString(),
    pair_id: 'pair_rogue',
    task_id: 'ghost',
    arm: 'babel_enforce',
    replicate_id: 0,
  };
  writeJsonAtomic(join(dir, 'attempts', `${rogue.attempt_id}.json`), rogue);

  const statesWithRogue = listAttemptStates(dir);
  const conservation = validateConservation(manifest, statesWithRogue);

  const derived = validateAndDeriveCampaign({
    evidenceDir: dir,
    manifest,
    states: statesWithRogue,
    writerCells: [],
  });

  // Duplicate attempt_id (in-memory; file system would overwrite same path)
  const a0 = statesWithRogue.find((s) => s.attempt_id === manifest.expected_attempts[0]!.attempt_id)!;
  const duplicateStates: AttemptState[] = [
    ...statesWithRogue.filter((s) => s.attempt_id !== rogue.attempt_id),
    { ...a0 },
    { ...a0, sequence: a0.sequence + 1 },
  ];
  // Drop one expected to also exercise missing + keep expected length wrong
  const missingAndDup = duplicateStates.filter(
    (s) => s.attempt_id !== manifest.expected_attempts[1]!.attempt_id,
  );
  // Re-add duplicate of a0
  const dupList: AttemptState[] = [...missingAndDup, { ...a0, sequence: 99 }];
  const duplicateConservation = validateConservation(manifest, dupList);

  // Orphan reconcile path: leave one running, process dead, grace elapsed
  const orphanDir = tmpEvidenceDir('causal-orphan-');
  const orphanManifest = seedSingleTaskCampaign({
    evidenceDir: orphanDir,
    campaignId: 'meas-fixture-orphan',
    taskId: 't_orphan',
    arm: 'babel_enforce',
  });
  const orphanId = orphanManifest.expected_attempts[0]!.attempt_id;
  transitionAttempt(orphanDir, orphanId, { lifecycle: 'running', substage: 'live' });
  writeJsonAtomic(join(orphanDir, 'process.json'), {
    schema_version: 1,
    pid: 999002,
    started_at: '2026-08-02T12:00:00.000Z',
    launch_method: 'fixture',
    evidence_dir: orphanDir,
    campaign_id: orphanManifest.campaign_id,
  });
  const orphanReconcile = reconcileCampaignEvidence({
    evidenceDir: orphanDir,
    graceMs: 0,
    nowMs: Date.parse('2026-08-02T13:00:00.000Z'),
    processTreeAlive: false,
  });

  return {
    evidenceDir: dir,
    conservation,
    derived,
    duplicateConservation,
    orphanReconcile,
  };
}

export type IdentityMismatchFixtureResult = {
  evidenceDir: string;
  derived: DerivedCampaignState;
  artifact_valid: boolean;
};

/**
 * Derived with expectedIdentity mismatch → artifact_valid false.
 */
export function runIdentityMismatchFixture(): IdentityMismatchFixtureResult {
  const dir = tmpEvidenceDir('causal-identity-');
  const taskId = 't_identity';
  const manifest = seedSingleTaskCampaign({
    evidenceDir: dir,
    campaignId: 'meas-fixture-identity',
    taskId,
    arm: 'babel_enforce',
    babel_commit: 'fixture-commit-abc',
    dataset_sha256: 'fixture-ds-deadbeef',
  });
  const attemptId = manifest.expected_attempts[0]!.attempt_id;
  terminalAttempt(dir, attemptId, 'agent:empty_patch');

  const derived = validateAndDeriveCampaign({
    evidenceDir: dir,
    expectedIdentity: {
      babel_commit: 'other-commit-not-matching',
      dataset_sha256: 'other-ds-sha',
    },
    writerCells: [],
  });

  return {
    evidenceDir: dir,
    derived,
    artifact_valid: derived.eligibility.artifact_valid,
  };
}

/**
 * Truncated/corrupt digest style: partial states vs full expected set.
 * Returns conservation failure for missing attempt state (digest incomplete).
 */
export function runTruncatedDigestFixture(): {
  evidenceDir: string;
  conservation: ConservationResult;
  derived: DerivedCampaignState;
} {
  const dir = tmpEvidenceDir('causal-trunc-');
  const manifest = buildCampaignManifest({
    campaignId: 'meas-fixture-trunc',
    createdAt: '2026-08-02T12:00:00.000Z',
    taskIds: ['t1', 't2'],
    arms: ['babel_prompt_control'],
    replicates: 1,
    identity: baseIdentity(),
  });
  writeCampaignManifest(dir, manifest);
  // Only seed first attempt (truncated evidence)
  const partial: AttemptState[] = [
    {
      schema_version: 1,
      kind: 'babel_causal_attempt_state',
      attempt_id: manifest.expected_attempts[0]!.attempt_id,
      campaign_id: manifest.campaign_id,
      lifecycle: 'terminal',
      sequence: 1,
      updated_at: new Date().toISOString(),
      pair_id: manifest.expected_attempts[0]!.pair_id,
      task_id: 't1',
      arm: 'babel_prompt_control',
      replicate_id: 0,
      terminal_signature: 'agent:task_pass',
    },
  ];
  writeJsonAtomic(
    join(dir, 'attempts', `${partial[0]!.attempt_id}.json`),
    partial[0],
  );

  const conservation = validateConservation(manifest, partial);
  const derived = validateAndDeriveCampaign({
    evidenceDir: dir,
    manifest,
    states: partial,
    writerCells: [],
  });

  return { evidenceDir: dir, conservation, derived };
}

/** Re-export load helper for tests that want to re-read seeded manifests. */
export { loadCampaignManifest };

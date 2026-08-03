/**
 * Slice 3 — Canonical multi-axis validator for causal chat-headless campaigns.
 *
 * Writer claims (campaign-report cells, attempt states) are **inputs**.
 * This module independently rebuilds eligibility flags and rates.
 * Harvest/monitor must prefer campaign-derived.json over raw writer booleans.
 *
 * Zod is the single source of truth; JSON Schema is generated via z.toJSONSchema.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  CAUSAL_SCORER_VERSION,
  campaignCompleteFromStates,
  listAttemptStates,
  loadCampaignManifest,
  sha256Hex,
  validateConservation,
  writeJsonAtomic,
  type AttemptState,
  type CampaignManifest,
} from './causalCampaignContract.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DERIVED_CAMPAIGN_KIND = 'babel_causal_campaign_derived' as const;
export const DERIVED_ATTEMPT_KIND = 'babel_causal_attempt_derived' as const;

/** Stable exclusion reasons for capability denominator (never for reliability). */
export const CAPABILITY_EXCLUSION_REASONS = [
  'orphaned',
  'provider_error',
  'environment_error',
  'blocked_policy',
  'blocked_external',
  'infra_fail',
  'skipped_infra',
  'identity_mismatch',
  'artifact_invalid',
  'official_evaluator_absent',
  'not_terminal',
  'arm_not_enforce',
] as const;
export type CapabilityExclusionReason = (typeof CAPABILITY_EXCLUSION_REASONS)[number];

// ─── Multi-axis scoring (independent; pass_mode env must not redefine) ───────

export const AxisResultSchema = z.enum([
  'pass',
  'fail',
  'null',
  'not_run',
  'error',
  'diagnostic_only',
]);
export type AxisResult = z.infer<typeof AxisResultSchema>;

/**
 * Five independent scoring axes.
 * gold_patch_similarity is diagnostic only — never sole capability proof.
 */
export const ScoringAxesSchema = z.object({
  execution_terminal: AxisResultSchema,
  babel_authoritative_verifier: AxisResultSchema,
  host_fail_to_pass: AxisResultSchema,
  official_evaluator: AxisResultSchema,
  gold_patch_similarity: AxisResultSchema,
});
export type ScoringAxes = z.infer<typeof ScoringAxesSchema>;

export const EligibilityFlagsSchema = z.object({
  /** Schema + conservation + digests OK (validator-computed, not self-attestation). */
  artifact_valid: z.boolean(),
  /** Every expected attempt is terminal or reconciled orphaned. */
  campaign_complete: z.boolean(),
  /** Complete + artifact_valid + identity match (includes blocked/orphan as real outcomes). */
  reliability_eligible: z.boolean(),
  /** Reliability bar + no false-complete / integrity failure. */
  promotion_eligible: z.boolean(),
  /** Complete and capability rates may be computed (exclusions applied). */
  capability_score_valid: z.boolean(),
});
export type EligibilityFlags = z.infer<typeof EligibilityFlagsSchema>;

export const RateSchema = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  rate: z.number().nullable(),
});
export type Rate = z.infer<typeof RateSchema>;

export const AttemptDerivedSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal(DERIVED_ATTEMPT_KIND),
  attempt_id: z.string().min(1),
  task_id: z.string().min(1),
  arm: z.string().min(1),
  replicate_id: z.number().int().nonnegative(),
  lifecycle: z.string().min(1),
  axes: ScoringAxesSchema,
  /** Capability verified pass using trusted oracle hierarchy for this context. */
  capability_verified_pass: z.boolean(),
  /** In capability conditional denominator? */
  capability_eligible: z.boolean(),
  capability_exclusion_reason: z.string().nullable(),
  /** Integrity flags that block promotion when true. */
  false_complete_suspected: z.boolean(),
  evidence_authority_failure: z.boolean(),
  artifact_valid: z.boolean(),
  notes: z.array(z.string()),
});
export type AttemptDerived = z.infer<typeof AttemptDerivedSchema>;

export const DerivedCampaignStateSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal(DERIVED_CAMPAIGN_KIND),
  scorer_version: z.string().min(1),
  campaign_id: z.string().min(1),
  evidence_dir: z.string().min(1),
  derived_at: z.string().min(1),
  eligibility: EligibilityFlagsSchema,
  conservation_ok: z.boolean(),
  conservation_errors: z.array(z.string()),
  by_lifecycle: z.record(z.string(), z.number().int().nonnegative()),
  expected_attempts: z.number().int().nonnegative(),
  /** Intent-to-treat: verified passes / all frozen expected attempts. */
  intent_to_treat_capability: RateSchema,
  /** Conditional: verified passes / capability-eligible attempts. */
  conditional_capability: RateSchema,
  exclusion_counts: z.record(z.string(), z.number().int().nonnegative()),
  attempts: z.array(AttemptDerivedSchema),
  /** Legacy pass_mode is display-only; never used to redefine axes. */
  legacy_pass_mode_display: z.string().nullable(),
  notes: z.array(z.string()),
});
export type DerivedCampaignState = z.infer<typeof DerivedCampaignStateSchema>;

// ─── Writer cell evidence (loose input; not trusted for eligibility alone) ───

/** Minimal live-cell shape accepted as writer input. */
export interface WriterCellEvidence {
  instance_id?: string;
  phase?: string;
  status?: string;
  signature?: string;
  patch_bytes?: number;
  gold_diff_ok?: boolean | null;
  fail_to_pass_ok?: boolean | null;
  fail_to_pass_class?: string | null;
  status_text?: string | null;
  cli_exit_code?: number | null;
  notes?: string[];
  /** Optional: in-session authoritative verifier claim from payload. */
  babel_authoritative_verifier?: boolean | null;
  babel_authoritative_verifier_command?: string | null;
  official_evaluator_pass?: boolean | null;
  scoreboard?: {
    host_fail_to_pass?: boolean | null;
    gold_diagnostic?: boolean | null;
    capability_primary?: string;
    gold_role?: string;
  };
  /** Optional integrity signals */
  false_complete_suspected?: boolean;
  evidence_authority_failure?: boolean;
}

// ─── Axis derivation ─────────────────────────────────────────────────────────

function axisFromBool(v: boolean | null | undefined, notRun = false): AxisResult {
  if (notRun || v === undefined) return 'not_run';
  if (v === null) return 'null';
  return v ? 'pass' : 'fail';
}

/**
 * Map host fail_to_pass class to axis (collect_error is error, not assert fail).
 */
export function hostFailToPassAxis(
  ok: boolean | null | undefined,
  cls: string | null | undefined,
): AxisResult {
  if (ok === undefined && (cls === undefined || cls === null || cls === 'skipped')) {
    return 'not_run';
  }
  if (cls === 'collect_error' || cls === 'env_error' || cls === 'timeout') return 'error';
  if (cls === 'skipped' || cls === 'unknown') return ok === true ? 'pass' : ok === false ? 'fail' : 'not_run';
  if (ok === true || cls === 'pass') return 'pass';
  if (ok === false || cls === 'assert_fail') return 'fail';
  if (ok === null) return 'null';
  return 'not_run';
}

export function executionTerminalAxis(
  lifecycle: string,
  signature: string | null | undefined,
): AxisResult {
  if (lifecycle === 'orphaned') return 'error';
  if (lifecycle === 'queued' || lifecycle === 'running') return 'not_run';
  if (!signature) return 'null';
  if (
    signature.startsWith('infra:') ||
    signature.includes('orphaned') ||
    signature.includes('timeout') ||
    signature.includes('missing_api')
  ) {
    // Structured terminal still exists; classify severity at exclusion layer
    return signature.includes('ok') || signature === 'infra:ok' ? 'pass' : 'fail';
  }
  // Any structured signature counts as a completed execution terminal observation
  return signature.includes('task_pass') || signature === 'agent:task_pass' ? 'pass' : 'fail';
}

/**
 * Capability verified pass (oracle hierarchy for fixture/live without official eval):
 * - Prefer official_evaluator when present (pass only)
 * - Else host fail_to_pass pass (provisional diagnostic when class=pass)
 * - Never gold alone
 * - Never in-session Babel verifier alone
 */
export function capabilityVerifiedPass(axes: ScoringAxes): boolean {
  if (axes.official_evaluator === 'pass') return true;
  if (axes.official_evaluator === 'fail') return false;
  // Provisional: host FTP pass only when axis is pass (not error/collect)
  if (axes.host_fail_to_pass === 'pass') return true;
  return false;
}

export function classifyCapabilityExclusion(input: {
  lifecycle: string;
  arm: string;
  signature: string | null | undefined;
  axes: ScoringAxes;
  artifact_valid: boolean;
  identity_mismatch: boolean;
}): CapabilityExclusionReason | null {
  if (!input.artifact_valid) return 'artifact_invalid';
  if (input.identity_mismatch) return 'identity_mismatch';
  if (input.lifecycle === 'orphaned') return 'orphaned';
  if (input.lifecycle === 'queued' || input.lifecycle === 'running') return 'not_terminal';
  // Conditional capability exclusions only. Host FTP pass means the cell is
  // scoreable — do not exclude on blocked_external/policy labels that may be
  // leftover terminal strings when the authoritative host oracle is green.
  if (input.axes.host_fail_to_pass === 'pass' || input.axes.official_evaluator === 'pass') {
    return null;
  }
  const sig = input.signature ?? '';
  if (sig.includes('skipped_infra')) return 'skipped_infra';
  if (sig.includes('missing_api') || sig.includes('provider_error')) return 'provider_error';
  if (
    sig.includes('env_blocked') ||
    sig.includes('ENV_BLOCKED') ||
    input.axes.host_fail_to_pass === 'error'
  ) {
    return 'environment_error';
  }
  if (sig.startsWith('infra:') && sig !== 'infra:ok') return 'infra_fail';
  if (sig.includes('BLOCKED_POLICY') || sig.includes('blocked_policy')) return 'blocked_policy';
  if (sig.includes('BLOCKED_EXTERNAL') || sig.includes('blocked_external')) return 'blocked_external';
  return null;
}

function makeRate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
  };
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function derivedCampaignPath(evidenceDir: string): string {
  return join(evidenceDir, 'campaign-derived.json');
}

// ─── Load writer cells ───────────────────────────────────────────────────────

export function loadWriterCellsFromEvidence(evidenceDir: string): WriterCellEvidence[] {
  const cells: WriterCellEvidence[] = [];
  const reportPath = join(evidenceDir, 'campaign-report.json');
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        cells?: WriterCellEvidence[];
        pass_mode?: string;
      };
      if (Array.isArray(report.cells)) {
        for (const c of report.cells) cells.push(c);
      }
    } catch {
      /* ignore corrupt report — quarantine path is separate */
    }
  }
  // Also scan live/*.json for cells not in report
  const liveDir = join(evidenceDir, 'live');
  if (existsSync(liveDir)) {
    for (const name of readdirSync(liveDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(liveDir, name), 'utf8')) as WriterCellEvidence;
        if (raw.instance_id && !cells.some((c) => c.instance_id === raw.instance_id && c.phase === raw.phase)) {
          cells.push(raw);
        }
      } catch {
        /* skip corrupt */
      }
    }
  }
  return cells;
}

function findLiveCell(
  cells: WriterCellEvidence[],
  taskId: string,
): WriterCellEvidence | undefined {
  return (
    cells.find((c) => c.instance_id === taskId && c.phase === 'live') ??
    cells.find((c) => c.instance_id === taskId && !c.phase) ??
    cells.find((c) => c.instance_id === taskId)
  );
}

function digestsMatch(expected: string | null | undefined, actual: string | null | undefined): boolean {
  if (!expected || !actual) return true; // missing digest is not an identity failure by itself
  return expected === actual;
}

// ─── Core validate ───────────────────────────────────────────────────────────

export interface ValidateCampaignOptions {
  evidenceDir: string;
  /** Injected now for tests */
  now?: Date;
  /** Optional identity re-check (commit/dataset) */
  expectedIdentity?: {
    babel_commit?: string | null;
    dataset_sha256?: string | null;
  };
  /** Inject cells (tests) */
  writerCells?: WriterCellEvidence[];
  /** Inject manifest/states (tests) */
  manifest?: CampaignManifest;
  states?: AttemptState[];
  legacyPassMode?: string | null;
}

/**
 * Rebuild derived campaign state from immutable manifest + attempt states + writer cells.
 * Does not trust campaign_complete or status=pass from writers alone.
 */
export function validateAndDeriveCampaign(
  options: ValidateCampaignOptions,
): DerivedCampaignState {
  const evidenceDir = options.evidenceDir;
  const notes: string[] = [];
  const manifest = options.manifest ?? loadCampaignManifest(evidenceDir);
  const states = options.states ?? listAttemptStates(evidenceDir);
  const cells = options.writerCells ?? loadWriterCellsFromEvidence(evidenceDir);

  const conservation = validateConservation(manifest, states);
  const complete = campaignCompleteFromStates(manifest, states) && conservation.ok;

  // Identity match: manifest vs optional expected
  let identity_ok = true;
  if (options.expectedIdentity) {
    if (
      options.expectedIdentity.babel_commit &&
      !digestsMatch(options.expectedIdentity.babel_commit, manifest.identity.babel_commit)
    ) {
      identity_ok = false;
      notes.push('identity_mismatch:babel_commit');
    }
    if (
      options.expectedIdentity.dataset_sha256 &&
      !digestsMatch(options.expectedIdentity.dataset_sha256, manifest.identity.dataset_sha256)
    ) {
      identity_ok = false;
      notes.push('identity_mismatch:dataset_sha256');
    }
  }
  if (manifest.identity.scorer_version !== CAUSAL_SCORER_VERSION) {
    notes.push(
      `scorer_version_mismatch manifest=${manifest.identity.scorer_version} code=${CAUSAL_SCORER_VERSION}`,
    );
  }

  // Quarantine corrupt attempt files: conservation already flags missing/unexpected
  const artifact_valid = conservation.ok && identity_ok;

  const attemptsDerived: AttemptDerived[] = [];
  const exclusion_counts: Record<string, number> = {};

  const stateById = new Map(states.map((s) => [s.attempt_id, s]));

  for (const exp of manifest.expected_attempts) {
    const st = stateById.get(exp.attempt_id);
    const lifecycle = st?.lifecycle ?? 'queued';
    const cell = findLiveCell(cells, exp.task_id);
    const signature = st?.terminal_signature ?? cell?.signature ?? null;

    // babel_authoritative: only true/false when explicitly set; null/undefined → not_run
    const babelAuth = cell?.babel_authoritative_verifier;
    const babelAuthAxis: AxisResult =
      babelAuth === true ? 'pass' : babelAuth === false ? 'fail' : 'not_run';

    const axes: ScoringAxes = {
      execution_terminal: executionTerminalAxis(lifecycle, signature),
      babel_authoritative_verifier: babelAuthAxis,
      host_fail_to_pass: hostFailToPassAxis(cell?.fail_to_pass_ok, cell?.fail_to_pass_class),
      official_evaluator: axisFromBool(
        cell?.official_evaluator_pass ?? null,
        cell?.official_evaluator_pass === undefined,
      ),
      // Gold is always diagnostic_only when observed; never a pass/fail capability axis.
      gold_patch_similarity:
        cell?.gold_diff_ok === true || cell?.gold_diff_ok === false
          ? 'diagnostic_only'
          : 'not_run',
    };

    const attempt_notes: string[] = [];
    if (cell?.gold_diff_ok === true) {
      attempt_notes.push('gold_diagnostic=true (multi-file PR ref; not capability sole criterion)');
    }
    if (cell?.gold_diff_ok === false) {
      attempt_notes.push('gold_diagnostic=false (multi-file PR ref; not capability sole criterion)');
    }
    if (cell?.fail_to_pass_ok === true && cell?.gold_diff_ok === false) {
      attempt_notes.push('gold_ftp_gap=true (host FTP pass with gold mismatch is expected product signal)');
    }
    if (cell?.babel_authoritative_verifier_command) {
      attempt_notes.push(`babel_auth_cmd=${cell.babel_authoritative_verifier_command.slice(0, 120)}`);
    }
    if (cell?.scoreboard?.capability_primary) {
      attempt_notes.push(`capability_primary=${cell.scoreboard.capability_primary}`);
    }

    const false_complete_suspected = Boolean(cell?.false_complete_suspected);
    const evidence_authority_failure = Boolean(cell?.evidence_authority_failure);
    // Heuristic: install-as-complete style signatures
    if (signature?.includes('false_complete') || cell?.notes?.some((n) => n.includes('false_complete'))) {
      attempt_notes.push('false_complete_signal');
    }

    const attempt_artifact_valid =
      artifact_valid &&
      st != null &&
      st.campaign_id === manifest.campaign_id &&
      st.attempt_id === exp.attempt_id;

    const exclusion = classifyCapabilityExclusion({
      lifecycle,
      arm: exp.arm,
      signature,
      axes,
      artifact_valid: attempt_artifact_valid,
      identity_mismatch: !identity_ok,
    });

    // Conditional capability: eligible if terminal, artifact ok, no exclusion.
    // ITT uses oracle pass on ALL attempts; conditional rate uses eligible ∩ pass.
    let capability_eligible = exclusion == null && lifecycle === 'terminal' && attempt_artifact_valid;
    if (exclusion) {
      exclusion_counts[exclusion] = (exclusion_counts[exclusion] ?? 0) + 1;
      capability_eligible = false;
    }

    const oracle_pass = capabilityVerifiedPass(axes);

    attemptsDerived.push(
      AttemptDerivedSchema.parse({
        schema_version: 1,
        kind: DERIVED_ATTEMPT_KIND,
        attempt_id: exp.attempt_id,
        task_id: exp.task_id,
        arm: exp.arm,
        replicate_id: exp.replicate_id,
        lifecycle,
        axes,
        // Intent-to-treat numerator: oracle truth independent of exclusion.
        capability_verified_pass: oracle_pass,
        capability_eligible,
        capability_exclusion_reason: exclusion,
        false_complete_suspected:
          false_complete_suspected ||
          Boolean(signature?.includes('false_complete')),
        evidence_authority_failure,
        artifact_valid: attempt_artifact_valid,
        notes: attempt_notes,
      }),
    );
  }

  // ITT: verified passes / all expected (exclusions do not remove from denom)
  const ittNum = attemptsDerived.filter((a) => a.capability_verified_pass).length;
  const ittDen = attemptsDerived.length;
  // Conditional: verified among capability-eligible only
  const condEligible = attemptsDerived.filter((a) => a.capability_eligible);
  const condNum = condEligible.filter((a) => a.capability_verified_pass).length;
  const condDen = condEligible.length;

  const any_false_complete = attemptsDerived.some((a) => a.false_complete_suspected);
  const any_authority_fail = attemptsDerived.some((a) => a.evidence_authority_failure);

  const eligibility: EligibilityFlags = {
    artifact_valid,
    campaign_complete: complete,
    reliability_eligible: complete && artifact_valid && identity_ok,
    promotion_eligible:
      complete &&
      artifact_valid &&
      identity_ok &&
      !any_false_complete &&
      !any_authority_fail &&
      conservation.ok,
    capability_score_valid: complete && artifact_valid && identity_ok,
  };

  // Legacy pass_mode from report (display only)
  let legacy_pass_mode_display: string | null = options.legacyPassMode ?? null;
  if (legacy_pass_mode_display == null) {
    try {
      const reportPath = join(evidenceDir, 'campaign-report.json');
      if (existsSync(reportPath)) {
        const r = JSON.parse(readFileSync(reportPath, 'utf8')) as { pass_mode?: string };
        legacy_pass_mode_display = r.pass_mode ?? null;
      }
    } catch {
      /* ignore */
    }
  }
  if (legacy_pass_mode_display) {
    notes.push(
      `legacy_pass_mode_display=${legacy_pass_mode_display} (display only; does not redefine axes)`,
    );
  }

  const derived: DerivedCampaignState = {
    schema_version: 1,
    kind: DERIVED_CAMPAIGN_KIND,
    scorer_version: CAUSAL_SCORER_VERSION,
    campaign_id: manifest.campaign_id,
    evidence_dir: evidenceDir,
    derived_at: (options.now ?? new Date()).toISOString(),
    eligibility,
    conservation_ok: conservation.ok,
    conservation_errors: conservation.errors,
    by_lifecycle: conservation.by_lifecycle,
    expected_attempts: manifest.expected_attempts.length,
    intent_to_treat_capability: makeRate(ittNum, ittDen),
    conditional_capability: makeRate(condNum, condDen),
    exclusion_counts,
    attempts: attemptsDerived,
    legacy_pass_mode_display,
    notes,
  };

  return DerivedCampaignStateSchema.parse(derived);
}

/**
 * Validate, write campaign-derived.json atomically, return derived state.
 */
export function writeDerivedCampaignState(
  options: ValidateCampaignOptions,
): DerivedCampaignState {
  const derived = validateAndDeriveCampaign(options);
  writeJsonAtomic(derivedCampaignPath(options.evidenceDir), derived);
  return derived;
}

/**
 * Digest of derived state for evidence integrity (excludes derived_at).
 */
export function derivedStateDigest(derived: DerivedCampaignState): string {
  const { derived_at: _d, ...rest } = derived;
  return sha256Hex(JSON.stringify(rest)).slice(0, 16);
}

// ─── JSON Schema export ──────────────────────────────────────────────────────

export function writeGeneratedValidatorSchemas(schemaDir: string): {
  derived: string;
  attempt: string;
} {
  mkdirSync(schemaDir, { recursive: true });
  const derived = join(schemaDir, 'causal-campaign-derived.schema.json');
  const attempt = join(schemaDir, 'causal-attempt-derived.schema.json');
  writeJsonAtomic(derived, z.toJSONSchema(DerivedCampaignStateSchema));
  writeJsonAtomic(attempt, z.toJSONSchema(AttemptDerivedSchema));
  return { derived, attempt };
}

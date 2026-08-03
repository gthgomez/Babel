/**
 * Causal chat-headless reliability benchmark — Stage 2 diagnostic ablation scaffolding.
 *
 * Slice 4: freeze a Stage 2 diagnostic manifest from Stage 1 pair_ids.
 * Stage 2 is exploratory only and MUST NEVER mutate the Stage 1 primary
 * causal denominator (campaign-manifest.json / Stage 1 manifest_digest).
 *
 * Zod is the runtime source of truth. JSON Schema is generated via z.toJSONSchema.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  CampaignManifestSchema,
  loadCampaignManifest,
  readJsonFile,
  sha256Hex,
  stableStringify,
  writeJsonAtomic,
  type CampaignManifest,
} from './causalCampaignContract.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const STAGE2_MANIFEST_KIND = 'babel_causal_stage2_manifest' as const;

/**
 * Known exploratory ablation arms (Stage 2 diagnostic only).
 * These are scaffolding identifiers for controlled ablations; they are not
 * part of the Stage 1 primary causal denominator.
 *
 * Pattern: `babel_ablation_*`
 */
export const CAUSAL_STAGE2_ABLATION_ARMS = [
  'babel_ablation_policy_off',
  'babel_ablation_progress_off',
  'babel_ablation_budget_relaxed',
] as const;
export type CausalStage2AblationArm = (typeof CAUSAL_STAGE2_ABLATION_ARMS)[number];

// ─── Zod schemas (source of truth) ───────────────────────────────────────────

export const CausalStage2AblationArmSchema = z.enum(CAUSAL_STAGE2_ABLATION_ARMS);

export const Stage2ExpectedAttemptSchema = z.object({
  attempt_id: z.string().min(1),
  /** Must reference a pair_id present in the parent Stage 1 expected_attempts. */
  pair_id: z.string().min(1),
  task_id: z.string().min(1),
  ablation_arm: CausalStage2AblationArmSchema,
  replicate_id: z.number().int().nonnegative(),
  arm_config_hash: z.string().min(1),
  /**
   * Stage 1 attempt_ids that triggered this Stage 2 diagnostic row
   * (typically control_verified_pass && babel_enforce non-pass selection).
   */
  triggering_stage1_attempt_ids: z.array(z.string().min(1)).min(1),
});
export type Stage2ExpectedAttempt = z.infer<typeof Stage2ExpectedAttemptSchema>;

export const Stage2ManifestSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal(STAGE2_MANIFEST_KIND),
  campaign_id: z.string().min(1),
  stage: z.literal(2),
  created_at: z.string().min(1),
  /** Digest of the parent Stage 1 campaign-manifest.json (frozen denominator). */
  parent_stage1_manifest_digest: z.string().min(1),
  parent_campaign_id: z.string().min(1),
  expected_attempts: z.array(Stage2ExpectedAttemptSchema).min(1),
  /** Hash of canonical JSON of the draft without this field. */
  manifest_digest: z.string().min(1),
  /** Stage 2 is always exploratory; never promotes into Stage 1 denominator. */
  exploratory: z.literal(true),
  notes: z.array(z.string()).default([]),
});
export type Stage2Manifest = z.infer<typeof Stage2ManifestSchema>;

// ─── Arm config hash (Stage 2 exploratory) ───────────────────────────────────

/**
 * Hash of exploratory ablation arm configuration.
 * Mirrors Stage 1 computeArmConfigHash shape but keys on ablation_arm.
 */
export function computeStage2ArmConfigHash(input: {
  ablation_arm: CausalStage2AblationArm;
  scorer_version?: string;
  extra?: Record<string, unknown>;
}): string {
  return sha256Hex(
    stableStringify({
      ablation_arm: input.ablation_arm,
      exploratory: true,
      scorer_version: input.scorer_version ?? 'causal-scorer-v1',
      ...(input.extra ?? {}),
    }),
  ).slice(0, 16);
}

export function makeStage2AttemptId(input: {
  campaignId: string;
  pairId: string;
  ablationArm: CausalStage2AblationArm;
  replicateId: number;
}): string {
  return `s2att_${sha256Hex(
    `${input.campaignId}|${input.pairId}|${input.ablationArm}|${input.replicateId}`,
  ).slice(0, 16)}`;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function stage2ManifestPath(evidenceDir: string): string {
  return join(evidenceDir, 'stage2-manifest.json');
}

// ─── Build ───────────────────────────────────────────────────────────────────

export interface BuildStage2ManifestInput {
  /**
   * Parent Stage 1 CampaignManifest, or load from evidenceDir when provided
   * as a path-bearing object via stage1Manifest / evidenceDir.
   */
  stage1Manifest: CampaignManifest;
  /**
   * Stage 1 pair_ids that trigger Stage 2 diagnostics
   * (caller selects where control_verified_pass && babel_enforce non-pass;
   * scaffolding does not run models).
   */
  triggeringPairIds: string[];
  /**
   * Optional explicit Stage 1 attempt_ids that triggered selection.
   * When omitted, all Stage 1 expected_attempts for each selected pair_id
   * are recorded as triggers.
   */
  triggeringStage1AttemptIds?: string[];
  /**
   * Ablation arms to freeze BEFORE running them. Must be non-empty.
   */
  ablationArms: CausalStage2AblationArm[];
  /** Stage 2 campaign id (defaults to `${parent}-stage2`). */
  campaignId?: string;
  createdAt?: string;
  notes?: string[];
  /** Replicate id stamped on Stage 2 attempts (default 0). */
  replicateId?: number;
  scorerVersion?: string;
}

/**
 * Freeze a Stage 2 diagnostic manifest from Stage 1 pair_ids.
 * Does NOT write campaign-manifest.json and never mutates Stage 1.
 */
export function buildStage2ManifestFromStage1(input: BuildStage2ManifestInput): Stage2Manifest {
  const stage1 = CampaignManifestSchema.parse(input.stage1Manifest);

  if (!input.ablationArms?.length) {
    throw new Error('Stage 2 requires a non-empty ablation arm set');
  }
  for (const arm of input.ablationArms) {
    if (!CAUSAL_STAGE2_ABLATION_ARMS.includes(arm)) {
      throw new Error(`Invalid Stage 2 ablation arm: ${arm}`);
    }
  }
  if (!input.triggeringPairIds?.length) {
    throw new Error('Stage 2 requires at least one triggering Stage 1 pair_id');
  }

  const stage1PairIds = new Set(stage1.expected_attempts.map((a) => a.pair_id));
  const stage1ByPair = new Map<string, CampaignManifest['expected_attempts']>();
  for (const att of stage1.expected_attempts) {
    const list = stage1ByPair.get(att.pair_id) ?? [];
    list.push(att);
    stage1ByPair.set(att.pair_id, list);
  }

  for (const pairId of input.triggeringPairIds) {
    if (!stage1PairIds.has(pairId)) {
      throw new Error(
        `Stage 2 pair_id not present in Stage 1 expected_attempts: ${pairId}`,
      );
    }
  }

  if (input.triggeringStage1AttemptIds?.length) {
    const known = new Set(stage1.expected_attempts.map((a) => a.attempt_id));
    for (const id of input.triggeringStage1AttemptIds) {
      if (!known.has(id)) {
        throw new Error(
          `triggering Stage 1 attempt_id not in Stage 1 expected_attempts: ${id}`,
        );
      }
    }
  }

  const campaignId = input.campaignId ?? `${stage1.campaign_id}-stage2`;
  const replicateId = input.replicateId ?? 0;
  const expected: Stage2ExpectedAttempt[] = [];

  for (const pairId of input.triggeringPairIds) {
    const stage1Attempts = stage1ByPair.get(pairId) ?? [];
    const taskId = stage1Attempts[0]!.task_id;
    const triggers =
      input.triggeringStage1AttemptIds?.filter((id) =>
        stage1Attempts.some((a) => a.attempt_id === id),
      ) ?? stage1Attempts.map((a) => a.attempt_id);

    if (!triggers.length) {
      throw new Error(
        `No triggering Stage 1 attempt_ids resolved for pair_id=${pairId}`,
      );
    }

    for (const ablation_arm of input.ablationArms) {
      const arm_config_hash = computeStage2ArmConfigHash({
        ablation_arm,
        scorer_version: input.scorerVersion ?? stage1.identity.scorer_version,
      });
      expected.push({
        attempt_id: makeStage2AttemptId({
          campaignId,
          pairId,
          ablationArm: ablation_arm,
          replicateId,
        }),
        pair_id: pairId,
        task_id: taskId,
        ablation_arm,
        replicate_id: replicateId,
        arm_config_hash,
        triggering_stage1_attempt_ids: [...triggers],
      });
    }
  }

  const draft = {
    schema_version: 1 as const,
    kind: STAGE2_MANIFEST_KIND,
    campaign_id: campaignId,
    stage: 2 as const,
    created_at: input.createdAt ?? new Date().toISOString(),
    parent_stage1_manifest_digest: stage1.manifest_digest,
    parent_campaign_id: stage1.campaign_id,
    expected_attempts: expected,
    exploratory: true as const,
    notes: input.notes ?? [],
  };
  const manifest_digest = sha256Hex(stableStringify(draft));
  const manifest: Stage2Manifest = { ...draft, manifest_digest };
  return Stage2ManifestSchema.parse(manifest);
}

// ─── I/O (immutable after write; never touches Stage 1) ──────────────────────

/**
 * Write stage2-manifest.json atomically. Immutable if an existing file has a
 * different digest (same pattern as Stage 1 writeCampaignManifest).
 * Does NOT rewrite campaign-manifest.json.
 */
export function writeStage2Manifest(evidenceDir: string, manifest: Stage2Manifest): string {
  const path = stage2ManifestPath(evidenceDir);
  if (existsSync(path)) {
    const existing = Stage2ManifestSchema.parse(readJsonFile(path));
    if (existing.manifest_digest !== manifest.manifest_digest) {
      throw new Error(
        `stage2-manifest.json already exists with different digest (immutable). existing=${existing.manifest_digest} new=${manifest.manifest_digest}`,
      );
    }
    return path;
  }
  const parsed = Stage2ManifestSchema.parse(manifest);
  if (parsed.exploratory !== true) {
    throw new Error('Stage 2 manifest must have exploratory: true');
  }
  writeJsonAtomic(path, parsed);
  return path;
}

export function loadStage2Manifest(evidenceDir: string): Stage2Manifest {
  const path = stage2ManifestPath(evidenceDir);
  if (!existsSync(path)) {
    throw new Error(`stage2-manifest.json missing: ${path}`);
  }
  return Stage2ManifestSchema.parse(readJsonFile(path));
}

/**
 * After Stage 2 write (or any Stage 2 work), load Stage 1 and assert its
 * manifest_digest is unchanged relative to stage1DigestBefore.
 */
export function assertStage2DoesNotMutateStage1(
  evidenceDir: string,
  stage1DigestBefore: string,
): void {
  const stage1 = loadCampaignManifest(evidenceDir);
  if (stage1.manifest_digest !== stage1DigestBefore) {
    throw new Error(
      `Stage 2 must not mutate Stage 1 primary causal denominator. ` +
        `before=${stage1DigestBefore} after=${stage1.manifest_digest}`,
    );
  }
}

// ─── JSON Schema export ──────────────────────────────────────────────────────

export function stage2ManifestJsonSchema(): unknown {
  return z.toJSONSchema(Stage2ManifestSchema);
}

export function writeGeneratedStage2Schemas(schemaDir: string): {
  stage2Manifest: string;
} {
  mkdirSync(schemaDir, { recursive: true });
  const stage2Manifest = join(schemaDir, 'causal-stage2-manifest.schema.json');
  writeJsonAtomic(stage2Manifest, z.toJSONSchema(Stage2ManifestSchema));
  return { stage2Manifest };
}

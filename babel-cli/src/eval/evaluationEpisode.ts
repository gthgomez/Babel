import { z } from 'zod'

import {
  EVIDENCE_SCOPES,
  SNAPSHOT_PIN_STRENGTHS,
  STREAM_COMPLETENESS,
} from './evalTypes.js'

export const EvaluationEpisodeSchema = z.object({
  schema_version: z.literal(1),
  evidence_scope: z.enum(EVIDENCE_SCOPES),
  claim_eligible: z.boolean(),
  diagnosis_confidence: z.enum(['full', 'partial', 'none']),
  evidence_completeness: z.object({
    session_events: z.enum(STREAM_COMPLETENESS),
    episode_events: z.enum(STREAM_COMPLETENESS),
    verifier_receipt: z.enum(STREAM_COMPLETENESS),
    hidden_grade: z.enum(STREAM_COMPLETENESS),
  }),
  identity: z.object({
    benchmark: z.string(),
    benchmark_version: z.string(),
    task_id: z.string(),
    task_class: z.string(),
    start_sha: z.string().nullable(),
    harness_sha: z.string().nullable(),
  }),
  harness_variant: z
    .object({
      id: z.string(),
      git_sha: z.string(),
      dist_hash: z.string(),
      source_tree_hash: z.string(),
    })
    .nullable(),
  model_control: z
    .object({
      requested_model: z.string(),
      resolved_model_if_reported: z.string().nullable(),
      provider: z.string(),
      request_id: z.string().nullable(),
      timestamp: z.string(),
      snapshot_pin_strength: z.enum(SNAPSHOT_PIN_STRENGTHS),
    })
    .nullable(),
  trajectory: z.object({
    turns: z.number().int().nonnegative(),
    searches: z.number().int().nonnegative(),
    reads: z.number().int().nonnegative(),
    mutations: z.number().int().nonnegative(),
    verifiers: z.number().int().nonnegative(),
    chronology_authority: z.enum(['episode_events', 'session_events', 'none']),
    chronology_disagreement: z.boolean(),
  }),
  outcome: z.object({
    visible_ok: z.boolean().nullable(),
    hidden_ok: z.boolean().nullable(),
    claimed_complete: z.boolean(),
    false_complete: z.boolean(),
    honest_block: z.boolean(),
    contract_success: z.boolean(),
    code_fix_success: z.boolean(),
    terminal_status: z.string(),
  }),
  economics: z.object({
    tokens: z.number().nullable(),
    cost_usd: z.number().nullable(),
    wall_ms: z.number().nullable(),
  }),
  diagnosis: z.object({
    flags: z.array(z.string()),
    failure_class: z.string().nullable(),
    evidence_event_ids: z.array(z.string()),
  }),
})

export type EvaluationEpisode = z.infer<typeof EvaluationEpisodeSchema>

export function isEvalClaimEligible(episode: EvaluationEpisode): boolean {
  return episode.claim_eligible === true
}

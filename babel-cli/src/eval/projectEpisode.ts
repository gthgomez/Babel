/**
 * Project EvaluationEpisode from existing streams. One authority per fact.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { droppedStderr } from './diagnostics/observation.js'
import { hadRepairEvidenceBeforeSecondMutation } from './diagnostics/repair.js'
import { isFalseComplete, isHonestBlock } from './diagnostics/completion.js'
import {
  EvaluationEpisodeSchema,
  type EvaluationEpisode,
} from './evaluationEpisode.js'
import type { EvidenceScope, StreamCompleteness } from './evalTypes.js'

export interface ProjectEpisodeInput {
  runDir: string
  task_id?: string
  evidence_scope?: EvidenceScope
  hidden_ok?: boolean | null
  visible_ok?: boolean | null
  claimed_complete?: boolean
  contract_success?: boolean
  code_fix_success?: boolean
}

interface LooseEvent {
  kind?: string
  event_id?: string
  seq?: number
  tool?: string
  observation?: string
  stderr?: string
  stdout?: string
  exitCode?: number
  command?: string
}

function loadJsonl(path: string): { completeness: StreamCompleteness; events: LooseEvent[] } {
  if (!existsSync(path)) return { completeness: 'missing', events: [] }
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return { completeness: 'missing', events: [] }
  const events: LooseEvent[] = []
  let partial = false
  for (const line of raw.split('\n')) {
    try {
      events.push(JSON.parse(line) as LooseEvent)
    } catch {
      partial = true
    }
  }
  return { completeness: partial ? 'partial' : 'complete', events }
}

function countKinds(events: LooseEvent[], kind: string | ((k: string) => boolean)): number {
  return events.filter((e) => {
    const k = String(e.kind ?? e.tool ?? '')
    return typeof kind === 'function' ? kind(k) : k === kind
  }).length
}

/**
 * Forensic projection: never throws on missing jsonl.
 */
export function projectEvaluationEpisode(input: ProjectEpisodeInput): EvaluationEpisode {
  const session = loadJsonl(join(input.runDir, 'session-events.jsonl'))
  const episode = loadJsonl(join(input.runDir, 'episode-events.jsonl'))
  const verifierPath = join(input.runDir, 'verifier-receipt.json')
  const gradePath = join(input.runDir, 'hidden-grade.json')
  const verifierPresent = existsSync(verifierPath)
  const gradePresent = existsSync(gradePath)

  let chronology_authority: EvaluationEpisode['trajectory']['chronology_authority'] = 'none'
  let chronology_events: LooseEvent[] = []
  if (episode.completeness !== 'missing' && episode.events.length > 0) {
    chronology_authority = 'episode_events'
    chronology_events = episode.events
  } else if (session.events.length > 0) {
    chronology_authority = 'session_events'
    chronology_events = session.events
  }

  const sessionStarts = countKinds(session.events, (k) => k === 'tool_started')
  const episodeStarts = countKinds(episode.events, (k) => k === 'tool_started' || k === 'tool.started')
  const chronology_disagreement =
    session.completeness !== 'missing' &&
    episode.completeness !== 'missing' &&
    sessionStarts > 0 &&
    episodeStarts > 0 &&
    sessionStarts !== episodeStarts

  const hidden_ok = input.hidden_ok ?? null
  const claimed = input.claimed_complete ?? false
  const flags: string[] = []
  for (const ev of chronology_events) {
    if (droppedStderr(String(ev.observation ?? ''), String(ev.stderr ?? ''))) {
      flags.push('observation_blindness')
      break
    }
  }
  const repair = hadRepairEvidenceBeforeSecondMutation(
    chronology_events.map((e) => {
      const mapped: { kind: string; observation?: string; stderr?: string; stdout?: string; exitCode?: number } = {
        kind: String(e.kind ?? ''),
      }
      if (e.observation !== undefined) mapped.observation = e.observation
      if (e.stderr !== undefined) mapped.stderr = e.stderr
      if (e.stdout !== undefined) mapped.stdout = e.stdout
      if (e.exitCode !== undefined) mapped.exitCode = e.exitCode
      return mapped
    }),
  )
  if (repair === false) flags.push('blind_repair')

  const completeness = {
    session_events: session.completeness,
    episode_events: episode.completeness,
    verifier_receipt: verifierPresent ? 'present' as const : 'missing' as const,
    hidden_grade: gradePresent ? 'present' as const : input.hidden_ok != null ? 'present' as const : 'missing' as const,
  }
  const claim_eligible =
    completeness.episode_events === 'complete' &&
    completeness.hidden_grade !== 'missing' &&
    !chronology_disagreement
  const diagnosis_confidence: EvaluationEpisode['diagnosis_confidence'] = claim_eligible
    ? 'full'
    : chronology_events.length > 0 || hidden_ok !== null || session.events.length > 0
      ? 'partial'
      : 'none'

  const false_complete = hidden_ok === null ? false : isFalseComplete(claimed, hidden_ok)
  const honest_block = hidden_ok === null ? false : isHonestBlock(claimed, hidden_ok)

  const episodeDoc: EvaluationEpisode = {
    schema_version: 1,
    evidence_scope: input.evidence_scope ?? 'FIXTURE_REPLAY',
    claim_eligible,
    diagnosis_confidence,
    evidence_completeness: completeness,
    identity: {
      benchmark: 'coding-canary',
      benchmark_version: 'v1',
      task_id: input.task_id ?? 'unknown',
      task_class: 'canary',
      start_sha: null,
      harness_sha: null,
    },
    harness_variant: null,
    model_control: null,
    trajectory: {
      turns: countKinds(chronology_events, (k) => k === 'turn_ended'),
      searches: countKinds(chronology_events, (k) => /search|grep/i.test(k)),
      reads: countKinds(chronology_events, (k) => /read/i.test(k)),
      mutations: countKinds(chronology_events, (k) => k === 'mutation' || k === 'mutation_batch'),
      verifiers: countKinds(chronology_events, (k) => k === 'verifier_attempt' || k === 'verifier'),
      chronology_authority,
      chronology_disagreement,
    },
    outcome: {
      visible_ok: input.visible_ok ?? null,
      hidden_ok,
      claimed_complete: claimed,
      false_complete,
      honest_block,
      contract_success: input.contract_success ?? false,
      code_fix_success: input.code_fix_success ?? false,
      terminal_status: honest_block ? 'honest_block' : false_complete ? 'false_complete' : hidden_ok ? 'hidden_ok' : 'unknown',
    },
    economics: { tokens: null, cost_usd: null, wall_ms: null },
    diagnosis: {
      flags: [...new Set(flags)],
      failure_class: false_complete ? 'false_complete' : null,
      evidence_event_ids: chronology_events
        .map((e) => e.event_id)
        .filter((id): id is string => typeof id === 'string'),
    },
  }
  return EvaluationEpisodeSchema.parse(episodeDoc)
}

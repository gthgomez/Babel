import { isReadDeliveryWindow, type ReadDeliveryWindow } from '../services/readDelivery.js'
/** Bounded observations, presentation safety, and protocol parsing helpers. */

import { extractJson } from '../utils/extractJson.js'
import {
  recoveryEvidenceKey,
  sameRecoveryBinding,
  type RecoveryEvidenceProvenance,
  type RecoveryCandidateBinding,
  type WorkingState,
} from './codingLoop/index.js'
import { ChatTurnSchema, type ChatTurn } from './chatToolDefinitions.js'
import { createHash } from 'node:crypto'
import type { ChatCallbacks } from './chatEngineContracts.js'

/**
 * R0-10: presentation callbacks are an observational side channel. A throwing
 * host callback must never unwind the settlement path — that would both skip
 * real execution bookkeeping and let the settlement catch append a duplicate
 * execution-truth row. Wrap every callback so a throw is logged and ignored.
 */
const PRESENTATION_CALLBACK_KEYS = [
  'onToolStart',
  'onToolComplete',
  'onFileChanged',
  'onSubAgentStart',
  'onSubAgentComplete',
  'onSubAgentFailed',
] as const

// Prevent exhausting connection pools
/**
 * I1: text-tools cap for the bounded child section. The section is already
 * bounded by childConclusion (2 KB conclusion + 0.5 KB error + 12 evidence
 * refs), so this is comfortably above its worst case and keeps the provenance
 * `authority` line and evidence tail visible on the text path.
 */
const SUB_AGENT_TEXT_MAX_CHARS = 6000

/**
 * S03/#213 slice 2: stable child delegation id bound to the parent operation
 * (run + turn + batch + action index + operation fingerprint), not a batch-local
 * counter. Distinct batches -> distinct ids; same delegation -> same id.
 */
export function deriveChildDelegationId(input: {
  parentRunId: string
  turnId: string
  batchId: string
  actionIndex: number
  fingerprint: string
}): string {
  const digest = createHash('sha256')
    .update(
      [
        input.parentRunId,
        input.turnId,
        input.batchId,
        String(input.actionIndex),
        input.fingerprint,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 12)
  return `chat-sub-${digest}`
}

/** S02: minimal shape of a text-tools log entry (see ChatEngine.toolCallLog). */
export interface TextToolResultEntry {
  tool: string
  target: string
  detail?: string
  error?: string
  exit_code?: number
  stdout?: string
  stderr?: string
}

/**
 * S02/#212: text-tools rendering was rebuilt from `toolCallLog` and only
 * surfaced read/grep/glob/list_dir/run_command stdout, so a read-only child
 * conclusion never reached the model on the text path. Extracted pure so both
 * delivery modes can be asserted directly.
 */
export function formatTextToolResults(
  entries: readonly TextToolResultEntry[],
): string {
  const parts: string[] = []
  for (const entry of entries) {
    if (entry.error === 'blocked') {
      parts.push(`[ERROR] ${entry.tool}:${entry.target} blocked`)
      continue
    }
    // S02/I1: sub_agent handoff (conclusion + status + evidence refs) before the
    // generic exit-code branch, so failed/policy-denied children still surface
    // their bounded result instead of a 500-char error slice. The child section
    // is self-bounded by childConclusion (conclusion/error/evidence caps), so it
    // gets a larger explicit cap than generic tool output — otherwise the
    // provenance `authority` line and evidence tail would be truncated away.
    if (entry.tool === 'sub_agent' && entry.stdout) {
      const out =
        entry.stdout.length > SUB_AGENT_TEXT_MAX_CHARS
          ? entry.stdout.slice(0, SUB_AGENT_TEXT_MAX_CHARS) +
            '\n... [truncated]'
          : entry.stdout
      parts.push(
        `[RESULT] ${entry.tool}:${entry.target}\n${entry.detail ? entry.detail + '\n' : ''}${out}`,
      )
      continue
    }
    if (entry.exit_code !== undefined && entry.exit_code !== 0) {
      const err = (entry.stderr || entry.stdout || '').slice(0, 500)
      parts.push(
        `[ERROR] ${entry.tool}:${entry.target} exit ${entry.exit_code}: ${err}`,
      )
      continue
    }
    // Tools whose output content the model needs to ingest
    if (
      entry.stdout &&
      ['read_file', 'read_range', 'grep', 'glob', 'list_dir'].includes(
        entry.tool,
      )
    ) {
      const truncated =
        entry.stdout.length > 3000
          ? entry.stdout.slice(0, 3000) + '\n... [truncated]'
          : entry.stdout
      parts.push(`[RESULT] ${entry.tool}:${entry.target}\n${truncated}`)
      continue
    }
    // run_command: include output
    if (entry.tool === 'run_command' && entry.stdout) {
      const out = entry.stdout.slice(0, 1000)
      parts.push(`[RESULT] ${entry.tool}:${entry.target}\n${out}`)
      continue
    }
    // Default: simple [OK] summary
    const detail = entry.detail ? ` (${entry.detail})` : ''
    parts.push(`[OK] ${entry.tool}:${entry.target}${detail}`)
  }
  return parts.join('\n\n')
}

/**
 * A discriminating observation is not a boolean claim. It must be
 * a host-delivered window from a concrete authorized read bound before and
 * after delivery. Diagnostic membership is a hint, not another permission
 * boundary. Rereads can republish retained facts without renewing progress or
 * consumed edit permits. Listings and search snippets do not clear the gate.
 */
export function isDiscriminatingInspectionEvidence(
  state: WorkingState,
  action: {
    type: string
    path?: string | undefined
    pattern?: string | undefined
    file_path?: string | undefined
  },
  physicalTarget: string | null,
  binding: RecoveryCandidateBinding | null,
  observationDigest: string,
  window?: ReadDeliveryWindow,
  bindingBefore?: RecoveryCandidateBinding | null,
): { discriminating: boolean; provenance?: RecoveryEvidenceProvenance } {
  const gate = state.recoveryGate
  if (!gate?.binding || !binding || !bindingBefore || !sameRecoveryBinding(gate.binding, binding) ||
      !sameRecoveryBinding(bindingBefore, binding) || !['read_file', 'read_range'].includes(action.type) ||
      !physicalTarget || !observationDigest || !isReadDeliveryWindow(window)) return { discriminating: false }
  const provenance: RecoveryEvidenceProvenance = { tool: action.type, target: physicalTarget,
    failureSignature: gate.failureSignature, binding, observationDigest, window }
  const key = recoveryEvidenceKey(provenance, gate.failureSignature)
  if (!key) return { discriminating: false }
  return { discriminating: !gate.permitConsumed && !state.consumedRecoveryEvidence.includes(key), provenance }
}

export function wrapPresentationCallbacks(
  callbacks: ChatCallbacks,
): ChatCallbacks {
  const wrapped: Record<string, unknown> = { ...callbacks }
  for (const key of PRESENTATION_CALLBACK_KEYS) {
    const fn = (callbacks as unknown as Record<string, unknown>)[key]
    if (typeof fn === 'function') {
      wrapped[key] = (...args: unknown[]): unknown => {
        try {
          return (fn as (...a: unknown[]) => unknown)(...args)
        } catch (err) {
          console.error(
            `[chatEngine] presentation callback ${key} failed (ignored):`,
            err,
          )
          return undefined
        }
      }
    }
  }
  return wrapped as unknown as ChatCallbacks
}

/** Parse a chat response while retaining prose and empty-response fallback. */
export function parseChatTurnLenient(rawText: string): ChatTurn {
  try {
    const parsed = extractJson(rawText)
    const result = ChatTurnSchema.safeParse(parsed)
    if (result.success) return result.data
    // JSON found but schema mismatch — could be a close miss.
    // If it has an "answer" field, treat it as completion directly.
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['answer'] === 'string'
    ) {
      return {
        type: 'completion',
        answer: (parsed as Record<string, unknown>)['answer'] as string,
      }
    }
  } catch {
    // No parseable JSON — model responded in prose. That's fine.
  }
  // Fallback: treat the entire raw response as a natural-language answer.
  const answer = rawText.trim()
  if (answer.length === 0) {
    return {
      type: 'completion',
      answer:
        'I could not produce a valid response. Please try rephrasing your request.',
    }
  }
  return { type: 'completion', answer }
}

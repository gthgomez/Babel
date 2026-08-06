import type { TerminalOutcome } from '../schemas/agentContracts.js'

/** Version of the shared executor contracts persisted in session metadata. */
export const EXECUTOR_CONTRACT_VERSION = 'executor-contract-v1' as const

/** Version of the canonical event stream consumed by executor controllers. */
export const EXECUTOR_EVENT_SCHEMA_VERSION = 1 as const

/** Version of the shared executor-kernel dependency boundary. */
export const EXECUTOR_KERNEL_VERSION = 'executor-kernel-v1' as const

/** Product execution modes with intentionally different controllers. */
export type BabelMode = 'chat' | 'plan' | 'deep'

/** Policy owned by a mode controller and enforced by the shared substrate. */
export interface ModePolicy {
  mode: BabelMode
  mutationPolicy: 'normal' | 'read_only' | 'governed'
  approvalPolicy: 'interactive' | 'handoff_required' | 'stage_gated'
  completionPolicy: 'executor' | 'plan_artifact' | 'proof_carrying'
}

/** Durable descriptor sufficient to reconstruct a server-owned session. */
export interface SessionDescriptor {
  schemaVersion: number
  threadId: string
  projectRoot: string
  mode: BabelMode
  provider: string
  model: string
  policyProfile: string
  createdAt: string
  kernelVersion: string
  contractVersion: string
  task?: string
}

/** Classification used to decide whether an interrupted effect is safe to reconcile. */
export type ToolEffectClass =
  | 'read_only'
  | 'idempotent'
  | 'reconcilable_mutation'
  | 'non_idempotent_local_effect'
  | 'external_side_effect'

/** Identity of the workspace state to which evidence is bound. */
export interface WorkspaceRevisionIdentity {
  gitCommitHash: string | null
  compositeTreeHash: string
  fileHashes: Record<string, string>
  capturedAt: number
}

/** Runtime-authoritative sources that may grant verifier authority. */
export const VERIFIER_AUTHORITY_SOURCES = [
  'project_discovery',
  'dataset_contract',
  'explicit_user_command',
  'built_in_runner',
] as const

/** Source that granted verifier authority. */
export type VerifierAuthoritySource = (typeof VERIFIER_AUTHORITY_SOURCES)[number]

/** Unresolved provenance used before authority has been established. */
export type UnresolvedVerifierAuthoritySource = VerifierAuthoritySource | 'unknown'

/** Runtime guard for canonical verifier authority provenance. */
export function isVerifierAuthoritySource(value: unknown): value is VerifierAuthoritySource {
  return typeof value === 'string' &&
    (VERIFIER_AUTHORITY_SOURCES as readonly string[]).includes(value)
}

/** Structured verifier command after authority resolution. */
export interface StructuredVerifierCommand {
  verifierId: string
  executable: string
  args: string[]
  authoritySource: UnresolvedVerifierAuthoritySource
  displayCommand: string
}

/** Revision-bound verifier evidence used by completion decisions. */
export interface ExecutorVerifierReceipt {
  receiptId: string
  verifierId?: string
  command: string
  exitCode: number
  authority: boolean
  authoritySource: VerifierAuthoritySource
  boundRevision: WorkspaceRevisionIdentity
  capturedAt: number
  stale: boolean
  staleReason?: string
}

/** Input used by the shared completion authority. */
export interface ExecutorCompletionInput {
  mode: BabelMode
  requestedOutcome: TerminalOutcome | 'PLAN_COMPLETE'
  hasWrite: boolean
  verificationPolicy: 'none' | 'required' | 'strict'
  lastVerifierReceipt?: ExecutorVerifierReceipt | null
  requiredVerifierCommands?: readonly string[] | null
  executedVerifierLedger?: readonly ExecutorVerifierReceipt[] | null
  verifierEvidenceErrors?: readonly string[] | null
  toolCallLog: {
    tool: string
    target: string
    error?: string
    exit_code?: number
    stale?: boolean
    mutation_paths?: string[]
  }[]
  proof?: { compliant: boolean; errors?: string[] }
  workspaceRevision?: WorkspaceRevisionIdentity
  evidenceRefs?: string[]
}

/** Durable decision made by the shared completion authority. */
export interface CompletionDecision {
  requestedOutcome: TerminalOutcome | 'PLAN_COMPLETE'
  finalOutcome: TerminalOutcome | 'PLAN_COMPLETE'
  allowed: boolean
  reason: string
  workspaceRevision?: WorkspaceRevisionIdentity
  evidenceRefs: string[]
  policyVersion: string
}

/** Canonical event categories shared by controllers and transports. */
export type CanonicalEventKind =
  | 'session'
  | 'turn'
  | 'tool'
  | 'mutation'
  | 'progress'
  | 'verifier'
  | 'completion'
  | 'recovery'

/** Transport-neutral event envelope for replay, TUI, and protocol adapters. */
export interface CanonicalExecutorEvent {
  schemaVersion: typeof EXECUTOR_EVENT_SCHEMA_VERSION
  eventId: string
  sessionId: string
  turnId: string | null
  seq: number
  ts: string
  kind: CanonicalEventKind
  type: string
  payload: Record<string, unknown>
}

/** Returns the fixed mode policy for a product mode. */
export function modePolicyFor(mode: BabelMode): ModePolicy {
  if (mode === 'plan') {
    return {
      mode,
      mutationPolicy: 'read_only',
      approvalPolicy: 'handoff_required',
      completionPolicy: 'plan_artifact',
    }
  }

  if (mode === 'deep') {
    return {
      mode,
      mutationPolicy: 'governed',
      approvalPolicy: 'stage_gated',
      completionPolicy: 'proof_carrying',
    }
  }

  return {
    mode,
    mutationPolicy: 'normal',
    approvalPolicy: 'interactive',
    completionPolicy: 'executor',
  }
}

/** Classifies a tool effect before execution so recovery can be conservative. */
export function classifyToolEffect(toolName: string): ToolEffectClass {
  const normalized = toolName.trim().toLowerCase()

  if (new Set([
    'read_file',
    'file_read',
    'list_dir',
    'grep',
    'glob',
    'semantic_search',
    'git_context',
    'workspace_map',
    'read_range',
  ]).has(normalized)) {
    return 'read_only'
  }

  if (new Set(['test_run', 'test', 'pytest']).has(normalized)) {
    return 'idempotent'
  }

  if (new Set([
    'write_file',
    'file_write',
    'apply_patch',
    'str_replace',
    'edit_file',
  ]).has(normalized)) {
    return 'reconcilable_mutation'
  }

  if (new Set(['run_command', 'shell_exec', 'await_command']).has(normalized)) {
    return 'non_idempotent_local_effect'
  }

  return 'external_side_effect'
}

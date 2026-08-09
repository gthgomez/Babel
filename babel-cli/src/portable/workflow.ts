/**
 * Portable workflow v1 contracts.
 *
 * These records are projections of native Babel authority. They are safe to
 * validate, serialize, compare, and export, but they do not execute work or
 * decide whether native evidence is authoritative.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InstructionManifestV1 } from '../agent/instructionManifest.js';
import type {
  CheckpointJournal,
  LiveSessionAuthority,
} from '../agent/liveSessionBridge.js';
import type { TaskContractV1 } from '../agent/taskContract.js';
import type {
  ExecutorVerifierReceipt,
  WorkspaceRevisionIdentity,
} from '../executor/contracts.js';

export const PORTABLE_WORKFLOW_VERSION = 'portable-workflow-v1' as const;

const HASH_PATTERN = /^[0-9a-f]{32,64}$/u;
const ID_PATTERN = /^[^\u0000-\u001f]{1,256}$/u;

export const PortableVersionSchema = z.literal(PORTABLE_WORKFLOW_VERSION);
export const PortableIdSchema = z.string().regex(ID_PATTERN);
export const PortableHashSchema = z.string().regex(HASH_PATTERN);

export const RevisionRefV1Schema = z
  .object({
    kind: z.literal('workspace-revision'),
    composite_tree_hash: PortableHashSchema,
    source: z.enum(['git', 'filesystem', 'native-authority']),
  })
  .strict();

export const EvidenceRefV1Schema = z
  .object({
    id: PortableIdSchema,
    kind: z.enum(['event', 'artifact', 'verifier-receipt', 'checkpoint']),
    sha256: PortableHashSchema,
    native_path: z.string().min(1).optional(),
  })
  .strict();

export const AuthorityRefV1Schema = z
  .object({
    native_kind: z.enum(['task-contract', 'instruction-manifest', 'live-session', 'episode']),
    native_id: PortableIdSchema,
    sha256: PortableHashSchema,
  })
  .strict();

export const VerifierIdentityV1Schema = z
  .object({
    command: z.string().min(1),
    command_sha256: PortableHashSchema,
    scope: z.array(z.string().min(1)),
    independent: z.boolean(),
    clean_room: z.boolean(),
  })
  .strict();

export const VerifierReceiptV1Schema = z
  .object({
    id: PortableIdSchema,
    status: z.enum(['passed', 'failed', 'blocked']),
    verifier: VerifierIdentityV1Schema,
    bound_revision: RevisionRefV1Schema,
    authority: AuthorityRefV1Schema,
    evidence: z.array(EvidenceRefV1Schema),
    exit_code: z.number().int().optional(),
    produced_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const TaskRefV1Schema = z
  .object({
    task_id: PortableIdSchema,
    goal: z.string(),
    acceptance_criteria: z.array(z.string()),
    mutation_policy: z.enum(['read_only', 'workspace_write', 'governed']),
    required_verifiers: z.array(z.string()),
  })
  .strict();

export const StageInputV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orient'), task: TaskRefV1Schema }).strict(),
  z
    .object({
      kind: z.literal('review'),
      task: TaskRefV1Schema,
      target_refs: z.array(EvidenceRefV1Schema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('attack'),
      task: TaskRefV1Schema,
      target_refs: z.array(EvidenceRefV1Schema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('integrate'),
      task: TaskRefV1Schema,
      stage_refs: z.array(PortableIdSchema),
    })
    .strict(),
]);

export const StageResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orient'), findings: z.array(z.string()) }).strict(),
  z
    .object({
      kind: z.literal('review'),
      findings: z.array(z.string()),
      required_changes: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('attack'),
      findings: z.array(z.string()),
      reproductions: z.array(EvidenceRefV1Schema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('integrate'),
      verifier_receipts: z.array(VerifierReceiptV1Schema),
      changed_refs: z.array(EvidenceRefV1Schema),
    })
    .strict(),
]);

export const StageRecordV1Schema = z
  .object({
    stage_id: PortableIdSchema,
    kind: z.enum(['orient', 'review', 'attack', 'integrate']),
    status: z.enum(['pending', 'running', 'passed', 'failed', 'blocked', 'cancelled']),
    input: StageInputV1Schema,
    result: StageResultV1Schema.optional(),
    workers: z.array(PortableIdSchema),
    evidence: z.array(EvidenceRefV1Schema),
  })
  .strict();

export const WorkerRunV1Schema = z
  .object({
    worker_id: PortableIdSchema,
    stage_id: PortableIdSchema,
    role: z.enum(['primary', 'reviewer', 'verifier', 'integrator']),
    status: z.enum(['pending', 'running', 'passed', 'failed', 'blocked', 'cancelled']),
    provider: z.string().min(1).optional(),
    native_authority: AuthorityRefV1Schema,
    evidence: z.array(EvidenceRefV1Schema),
  })
  .strict();

export const TerminalOutcomeV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('completed_verified'),
      receipts: z.array(PortableIdSchema),
      revision: RevisionRefV1Schema,
    })
    .strict(),
  z.object({ kind: z.literal('completed_unverified'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('blocked_external'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('blocked_policy'), reason: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('budget_exhausted'),
      dimension: z.enum(['turns', 'tokens', 'repair', 'infra']),
    })
    .strict(),
  z.object({ kind: z.literal('cancelled'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('infra_failure'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('agent_failure'), reason: z.string().min(1) }).strict(),
]);

export const WorkflowRunV1Schema = z
  .object({
    version: PortableVersionSchema,
    run_id: PortableIdSchema,
    task: TaskRefV1Schema,
    authority: AuthorityRefV1Schema,
    stages: z.array(StageRecordV1Schema),
    workers: z.array(WorkerRunV1Schema),
    terminal: TerminalOutcomeV1Schema.optional(),
    revision: RevisionRefV1Schema.optional(),
    evidence: z.array(EvidenceRefV1Schema),
  })
  .strict();

export const FailureClassV1Schema = z.enum([
  'task',
  'context',
  'implementation',
  'verifier',
  'infrastructure',
  'policy',
  'provider',
  'budget',
]);

export const RepairTransitionV1Schema = z
  .object({
    from: z.enum(['failed', 'blocked']),
    to: z.enum(['pending', 'running']),
    class: FailureClassV1Schema,
    reason: z.string().min(1),
    invalidates_receipts: z.boolean(),
    evidence: z.array(EvidenceRefV1Schema),
  })
  .strict();

export const GoalAmendmentV1Schema = z
  .object({
    amendment_id: PortableIdSchema,
    previous_task_id: PortableIdSchema,
    new_task: TaskRefV1Schema,
    approved_by: z.enum(['user', 'controller']),
    invalidates_receipts: z.boolean(),
  })
  .strict();

export const PortableExportV1Schema = z
  .object({
    version: PortableVersionSchema,
    run: WorkflowRunV1Schema,
    redaction_profile: z.enum(['public', 'internal', 'diagnostic']),
    exported_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type RevisionRefV1 = z.infer<typeof RevisionRefV1Schema>;
export type EvidenceRefV1 = z.infer<typeof EvidenceRefV1Schema>;
export type AuthorityRefV1 = z.infer<typeof AuthorityRefV1Schema>;
export type VerifierIdentityV1 = z.infer<typeof VerifierIdentityV1Schema>;
export type VerifierReceiptV1 = z.infer<typeof VerifierReceiptV1Schema>;
export type TaskRefV1 = z.infer<typeof TaskRefV1Schema>;
export type StageInputV1 = z.infer<typeof StageInputV1Schema>;
export type StageResultV1 = z.infer<typeof StageResultV1Schema>;
export type StageRecordV1 = z.infer<typeof StageRecordV1Schema>;
export type WorkerRunV1 = z.infer<typeof WorkerRunV1Schema>;
export type TerminalOutcomeV1 = z.infer<typeof TerminalOutcomeV1Schema>;
export type WorkflowRunV1 = z.infer<typeof WorkflowRunV1Schema>;
export type FailureClassV1 = z.infer<typeof FailureClassV1Schema>;
export type RepairTransitionV1 = z.infer<typeof RepairTransitionV1Schema>;
export type GoalAmendmentV1 = z.infer<typeof GoalAmendmentV1Schema>;
export type PortableExportV1 = z.infer<typeof PortableExportV1Schema>;

export type PortableRunValidation =
  | { ok: true; value: WorkflowRunV1 }
  | { ok: false; errors: string[] };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
}

function allVerifierReceipts(run: WorkflowRunV1): VerifierReceiptV1[] {
  return run.stages.flatMap((stage) =>
    stage.result?.kind === 'integrate' ? stage.result.verifier_receipts : [],
  );
}

function evidenceIds(run: WorkflowRunV1): Set<string> {
  const ids = new Set(run.evidence.map((item) => item.id));
  for (const stage of run.stages) {
    for (const item of stage.evidence) ids.add(item.id);
    if (stage.result?.kind === 'attack') {
      for (const item of stage.result.reproductions) ids.add(item.id);
    }
    if (stage.result?.kind === 'integrate') {
      for (const item of stage.result.changed_refs) ids.add(item.id);
    }
  }
  for (const worker of run.workers) {
    for (const item of worker.evidence) ids.add(item.id);
  }
  return ids;
}

/** Validate both the closed schema and the cross-record authority invariants. */
export function validateWorkflowRunV1(input: unknown): PortableRunValidation {
  const parsed = WorkflowRunV1Schema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: formatZodErrors(parsed.error) };

  const run = parsed.data;
  const errors: string[] = [];
  const stageIds = new Set<string>();
  const workerIds = new Set<string>();
  const receiptById = new Map<string, VerifierReceiptV1>();
  const knownEvidence = evidenceIds(run);

  for (const stage of run.stages) {
    if (stageIds.has(stage.stage_id)) errors.push(`duplicate stage: ${stage.stage_id}`);
    stageIds.add(stage.stage_id);
    if (stage.input.task.task_id !== run.task.task_id) {
      errors.push(`stage task mismatch: ${stage.stage_id}`);
    }
    if (stage.status === 'passed' && (!stage.result || stage.evidence.length === 0)) {
      errors.push(`passed stage requires result and evidence: ${stage.stage_id}`);
    }
    if (stage.result?.kind === 'integrate') {
      for (const receipt of stage.result.verifier_receipts) {
        if (receiptById.has(receipt.id)) errors.push(`duplicate receipt: ${receipt.id}`);
        receiptById.set(receipt.id, receipt);
        for (const evidence of receipt.evidence) {
          if (!knownEvidence.has(evidence.id)) errors.push(`unknown receipt evidence: ${evidence.id}`);
        }
      }
      if (stage.input.kind === 'integrate') {
        for (const referencedStage of stage.input.stage_refs) {
          const target = run.stages.find((candidate) => candidate.stage_id === referencedStage);
          if (!target) errors.push(`missing integrated stage: ${referencedStage}`);
          else if (!['passed', 'failed', 'blocked', 'cancelled'].includes(target.status)) {
            errors.push(`integrate stage references non-terminal stage: ${referencedStage}`);
          }
        }
      }
    }
  }

  for (const worker of run.workers) {
    if (workerIds.has(worker.worker_id)) errors.push(`duplicate worker: ${worker.worker_id}`);
    workerIds.add(worker.worker_id);
    const stage = run.stages.find((candidate) => candidate.stage_id === worker.stage_id);
    if (!stage) errors.push(`worker references missing stage: ${worker.worker_id}`);
    else if (!stage.workers.includes(worker.worker_id)) {
      errors.push(`worker parent mismatch: ${worker.worker_id}`);
    }
  }

  if (run.terminal?.kind === 'completed_verified') {
    if (!run.revision) errors.push('verified completion requires a run revision');
    for (const receiptId of run.terminal.receipts) {
      const receipt = receiptById.get(receiptId);
      if (!receipt) errors.push(`verified completion references missing receipt: ${receiptId}`);
      else {
        if (receipt.status !== 'passed') errors.push(`receipt is not passed: ${receiptId}`);
        if (run.revision && receipt.bound_revision.composite_tree_hash !== run.revision.composite_tree_hash) {
          errors.push(`receipt revision mismatch: ${receiptId}`);
        }
        if (receipt.evidence.some((item) => !knownEvidence.has(item.id))) {
          errors.push(`receipt evidence is not attached: ${receiptId}`);
        }
      }
    }
  }

  if (run.terminal && run.stages.some((stage) => ['pending', 'running'].includes(stage.status))) {
    errors.push('terminal run has unresolved stages');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: run };
}

/** Validate and parse a portable export, rejecting unknown fields and versions. */
export function parsePortableExportV1(input: unknown): PortableExportV1 {
  const parsed = PortableExportV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid portable export: ${formatZodErrors(parsed.error).join('; ')}`);
  }
  const run = validateWorkflowRunV1(parsed.data.run);
  if (!run.ok) throw new Error(`Invalid portable run: ${run.errors.join('; ')}`);
  return { ...parsed.data, run: run.value };
}

/** Enforce the portable pending/running/passed repair transition graph. */
export function assertStageTransition(
  from: StageRecordV1['status'],
  to: StageRecordV1['status'],
): void {
  const allowed: Record<StageRecordV1['status'], readonly StageRecordV1['status'][]> = {
    pending: ['running', 'cancelled'],
    running: ['passed', 'failed', 'blocked', 'cancelled'],
    passed: [],
    failed: ['pending'],
    blocked: ['pending'],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`Invalid portable stage transition: ${from} -> ${to}`);
}

/** Repairs after a mutation must invalidate receipts from the superseded run. */
export function assertRepairTransition(transition: RepairTransitionV1, hasRelevantMutation: boolean): void {
  RepairTransitionV1Schema.parse(transition);
  if (hasRelevantMutation && !transition.invalidates_receipts) {
    throw new Error('Repair transition must invalidate receipts after a relevant mutation');
  }
}

/** Goal amendments cannot carry receipts across task identity changes. */
export function assertGoalAmendment(amendment: GoalAmendmentV1): void {
  GoalAmendmentV1Schema.parse(amendment);
  if (amendment.previous_task_id === amendment.new_task.task_id) {
    throw new Error('Goal amendment must create a new task identity');
  }
  if (!amendment.invalidates_receipts) {
    throw new Error('Goal amendment must invalidate receipts');
  }
}

/** Project a native task contract without creating a second task authority. */
export function toPortableTaskRefV1(contract: TaskContractV1): TaskRefV1 {
  const mutationPolicy: TaskRefV1['mutation_policy'] = contract.allowed_effects.includes('read_only') &&
    contract.allowed_effects.every((effect) => effect === 'read_only')
    ? 'read_only'
    : contract.allowed_effects.includes('reconcilable_mutation')
      ? 'governed'
      : 'workspace_write';
  return TaskRefV1Schema.parse({
    task_id: contract.contract_id,
    goal: contract.user_request,
    acceptance_criteria: [...contract.acceptance_criteria],
    mutation_policy: mutationPolicy,
    required_verifiers: [...contract.verifier_requirements],
  });
}

/** Project an existing native authority record by stable ID and content hash. */
export function toPortableAuthorityRefV1(
  nativeKind: AuthorityRefV1['native_kind'],
  nativeId: string,
  nativeValue: unknown,
): AuthorityRefV1 {
  return AuthorityRefV1Schema.parse({
    native_kind: nativeKind,
    native_id: nativeId,
    sha256: sha256(nativeValue),
  });
}

export function toTaskContractAuthorityRefV1(contract: TaskContractV1): AuthorityRefV1 {
  return toPortableAuthorityRefV1('task-contract', contract.contract_id, contract);
}

export function toInstructionManifestAuthorityRefV1(manifest: InstructionManifestV1): AuthorityRefV1 {
  return toPortableAuthorityRefV1('instruction-manifest', manifest.manifest_id, manifest);
}

export function toLiveSessionAuthorityRefV1(authority: LiveSessionAuthority): AuthorityRefV1 {
  const nativeId = `${authority.taskContract.contract_id}:${authority.instructionManifest.manifest_id}`;
  return toPortableAuthorityRefV1('live-session', nativeId, authority);
}

export function toPortableRevisionRefV1(
  revision: Pick<WorkspaceRevisionIdentity, 'compositeTreeHash' | 'gitCommitHash'>,
  source?: RevisionRefV1['source'],
): RevisionRefV1 {
  return RevisionRefV1Schema.parse({
    kind: 'workspace-revision',
    composite_tree_hash: revision.compositeTreeHash,
    source: source ?? (revision.gitCommitHash ? 'git' : 'filesystem'),
  });
}

/** Project an executor receipt only when its native authority is supplied explicitly. */
export function toPortableVerifierReceiptV1(input: {
  receipt: ExecutorVerifierReceipt;
  authority: AuthorityRefV1;
  evidence: EvidenceRefV1[];
  scope?: string[];
  independent?: boolean;
  cleanRoom?: boolean;
}): VerifierReceiptV1 {
  const receipt = input.receipt;
  const status: VerifierReceiptV1['status'] = receipt.stale
    ? 'blocked'
    : receipt.exitCode === 0 && receipt.authority
      ? 'passed'
      : 'failed';
  return VerifierReceiptV1Schema.parse({
    id: receipt.receiptId,
    status,
    verifier: {
      command: receipt.command,
      command_sha256: sha256(receipt.command),
      scope: input.scope ?? [receipt.verifierId ?? 'verifier'],
      independent: input.independent ?? false,
      clean_room: input.cleanRoom ?? false,
    },
    bound_revision: toPortableRevisionRefV1(receipt.boundRevision),
    authority: input.authority,
    evidence: input.evidence,
    ...(receipt.exitCode !== undefined ? { exit_code: receipt.exitCode } : {}),
    produced_at: new Date(receipt.capturedAt).toISOString(),
  });
}

export type PortableRecoveryResult =
  | { status: 'none' }
  | { status: 'replayed'; run: WorkflowRunV1 }
  | { status: 'blocked'; terminal: Extract<TerminalOutcomeV1, { kind: 'blocked_external' | 'infra_failure' }> };

/** Recover only committed native generations; never guess for a prepared journal. */
export function recoverPortableRun(input: {
  journal?: Pick<CheckpointJournal, 'schema_version' | 'status' | 'batch_id' | 'backups_ready' | 'targets'> | null;
  committedRun?: WorkflowRunV1;
}): PortableRecoveryResult {
  if (!input.journal) return { status: 'none' };
  if (input.journal.schema_version !== 1 || !input.journal.batch_id || input.journal.targets.length === 0) {
    return {
      status: 'blocked',
      terminal: { kind: 'infra_failure', reason: 'native checkpoint journal is invalid' },
    };
  }
  if (input.journal.status === 'committed') {
    if (!input.committedRun) {
      return {
        status: 'blocked',
        terminal: { kind: 'infra_failure', reason: 'committed checkpoint has no portable projection' },
      };
    }
    const validation = validateWorkflowRunV1(input.committedRun);
    if (!validation.ok) {
      return {
        status: 'blocked',
        terminal: { kind: 'infra_failure', reason: `committed projection is invalid: ${validation.errors.join('; ')}` },
      };
    }
    return { status: 'replayed', run: validation.value };
  }
  return {
    status: 'blocked',
    terminal: {
      kind: 'blocked_external',
      reason: 'native checkpoint was prepared but its commit state is ambiguous',
    },
  };
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|authorization|credential|password|secret|token)/iu;
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s"']+/gu;
const POSIX_PATH_PATTERN = /\/(?:Users|home|private|workspace|tmp|var)\/[^\s"']+/gu;
const PRIVATE_URL_PATTERN = /https?:\/\/[^\s"']*(?:private|internal|localhost|127\.0\.0\.1)[^\s"']*/giu;

function redactPortableString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|credential|password|secret|token)\s*[:=]\s*)[^\s"']+/giu, '$1[REDACTED]')
    .replace(PRIVATE_URL_PATTERN, '[REDACTED_URL]')
    .replace(WINDOWS_PATH_PATTERN, '[REDACTED_PATH]')
    .replace(POSIX_PATH_PATTERN, '[REDACTED_PATH]');
}

function redactPublicValue(value: unknown, key?: string): unknown {
  if (key === 'native_path') return undefined;
  if (key && SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactPortableString(value);
  if (Array.isArray(value)) return value.map((item) => redactPublicValue(item));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactPublicValue(nestedValue, nestedKey);
      if (redacted !== undefined) output[nestedKey] = redacted;
    }
    return output;
  }
  return value;
}

/** Produce a public export with denied fields and machine-local data removed. */
export function redactPortableExport(exportValue: PortableExportV1): PortableExportV1 {
  const parsed = PortableExportV1Schema.parse(exportValue);
  return PortableExportV1Schema.parse(redactPublicValue(parsed) as PortableExportV1);
}

/** Serialize only a validated export; public exports are redacted by default. */
export function serializePortableExport(
  exportValue: PortableExportV1,
  profile: PortableExportV1['redaction_profile'] = 'public',
): string {
  const parsed = PortableExportV1Schema.parse({ ...exportValue, redaction_profile: profile });
  const output = profile === 'public' ? redactPortableExport(parsed) : parsed;
  return JSON.stringify(output, null, 2);
}

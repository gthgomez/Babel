import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';

export const APPROVAL_KINDS = ['dependency_install', 'model_escalation'] as const;
export type ApprovalKind = typeof APPROVAL_KINDS[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];

export interface ApprovalRecord {
  schema_version: 1;
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  fingerprint: string;
  summary: string;
  reason: string;
  requested_at: string;
  updated_at: string;
  decided_at: string | null;
  expires_at: string | null;
  scope: {
    project_root: string | null;
    execution_profile: string | null;
  };
  payload: Record<string, string | number | boolean | null>;
}

export interface ApprovalQueueFile {
  schema_version: 1;
  records: ApprovalRecord[];
}

export interface ApprovalRequestInput {
  kind: ApprovalKind;
  summary: string;
  reason: string;
  scope?: {
    projectRoot?: string | null;
    executionProfile?: string | null;
  };
  payload: Record<string, string | number | boolean | null | undefined>;
}

export interface DependencyInstallApprovalInput {
  command: string;
  projectRoot?: string | null;
  executionProfile?: string | null;
}

export interface ModelEscalationApprovalInput {
  task: string;
  model?: string | null;
  modelTier?: string | null;
  projectRoot?: string | null;
}

export interface ApprovalRequestResult {
  record: ApprovalRecord;
  created: boolean;
}

function getApprovalQueuePath(): string {
  const explicit = process.env['BABEL_APPROVAL_QUEUE_PATH']?.trim();
  return explicit && explicit.length > 0
    ? resolve(explicit)
    : join(BABEL_RUNS_DIR, 'approval-queue.json');
}

function normalizePayload(
  payload: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string | number | boolean | null>;
}

function normalizeProjectRoot(projectRoot: string | null | undefined): string | null {
  const trimmed = String(projectRoot ?? '').trim();
  return trimmed.length > 0 ? resolve(trimmed) : null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function fingerprintApproval(input: ApprovalRequestInput): string {
  const canonical = {
    kind: input.kind,
    scope: {
      project_root: normalizeProjectRoot(input.scope?.projectRoot ?? null),
      execution_profile: input.scope?.executionProfile ?? null,
    },
    payload: normalizePayload(input.payload),
  };
  return createHash('sha256').update(stableJson(canonical)).digest('hex').slice(0, 16);
}

function makeApprovalId(kind: ApprovalKind, fingerprint: string): string {
  const prefix = kind === 'dependency_install' ? 'dep' : 'model';
  return `${prefix}-${fingerprint}`;
}

function computedStatus(record: ApprovalRecord, now = new Date()): ApprovalStatus {
  if (
    record.status === 'approved' &&
    record.expires_at !== null &&
    Date.parse(record.expires_at) <= now.getTime()
  ) {
    return 'expired';
  }
  return record.status;
}

function normalizeRecord(record: ApprovalRecord): ApprovalRecord {
  return {
    ...record,
    status: computedStatus(record),
  };
}

export function readApprovalQueue(): ApprovalQueueFile & { path: string } {
  const path = getApprovalQueuePath();
  if (!existsSync(path)) {
    return { schema_version: 1, records: [], path };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ApprovalQueueFile>;
    const records = Array.isArray(parsed.records)
      ? parsed.records.filter((record): record is ApprovalRecord =>
          record !== null &&
          typeof record === 'object' &&
          typeof (record as ApprovalRecord).id === 'string' &&
          APPROVAL_KINDS.includes((record as ApprovalRecord).kind) &&
          APPROVAL_STATUSES.includes((record as ApprovalRecord).status),
        )
      : [];
    return {
      schema_version: 1,
      records: records.map(normalizeRecord),
      path,
    };
  } catch {
    return { schema_version: 1, records: [], path };
  }
}

function writeApprovalQueue(records: ApprovalRecord[]): ApprovalQueueFile & { path: string } {
  const path = getApprovalQueuePath();
  mkdirSync(dirname(path), { recursive: true });
  const queue = {
    schema_version: 1 as const,
    records: records.map(normalizeRecord),
  };
  writeFileSync(path, `${JSON.stringify(queue, null, 2)}\n`, 'utf-8');
  return { ...queue, path };
}

export function listApprovals(options: { status?: ApprovalStatus | 'all' } = {}): ApprovalRecord[] {
  const status = options.status ?? 'all';
  return readApprovalQueue().records
    .map(normalizeRecord)
    .filter(record => status === 'all' || record.status === status)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function inspectApproval(id: string): ApprovalRecord | null {
  return readApprovalQueue().records.find(record => record.id === id) ?? null;
}

export function createOrReuseApprovalRequest(input: ApprovalRequestInput): ApprovalRequestResult {
  const now = new Date().toISOString();
  const queue = readApprovalQueue();
  const fingerprint = fingerprintApproval(input);
  const existing = queue.records.find(record => record.fingerprint === fingerprint);
  if (existing && existing.status !== 'expired') {
    return { record: existing, created: false };
  }

  const record: ApprovalRecord = {
    schema_version: 1,
    id: makeApprovalId(input.kind, fingerprint),
    kind: input.kind,
    status: 'pending',
    fingerprint,
    summary: input.summary,
    reason: input.reason,
    requested_at: now,
    updated_at: now,
    decided_at: null,
    expires_at: null,
    scope: {
      project_root: normalizeProjectRoot(input.scope?.projectRoot ?? null),
      execution_profile: input.scope?.executionProfile ?? null,
    },
    payload: normalizePayload(input.payload),
  };

  const nextRecords = [
    ...queue.records.filter(candidate => candidate.fingerprint !== fingerprint),
    record,
  ];
  writeApprovalQueue(nextRecords);
  return { record, created: true };
}

export function approveApproval(id: string, options: { ttlHours?: number } = {}): ApprovalRecord {
  const queue = readApprovalQueue();
  const index = queue.records.findIndex(record => record.id === id);
  if (index < 0) {
    throw new Error(`Approval request not found: ${id}`);
  }

  const ttlHours = Math.max(1, options.ttlHours ?? 24);
  const now = new Date();
  const record = {
    ...queue.records[index]!,
    status: 'approved' as const,
    updated_at: now.toISOString(),
    decided_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
  };
  const records = [...queue.records];
  records[index] = record;
  writeApprovalQueue(records);
  return record;
}

export function denyApproval(id: string): ApprovalRecord {
  const queue = readApprovalQueue();
  const index = queue.records.findIndex(record => record.id === id);
  if (index < 0) {
    throw new Error(`Approval request not found: ${id}`);
  }

  const now = new Date().toISOString();
  const record = {
    ...queue.records[index]!,
    status: 'denied' as const,
    updated_at: now,
    decided_at: now,
    expires_at: null,
  };
  const records = [...queue.records];
  records[index] = record;
  writeApprovalQueue(records);
  return record;
}

export function getApprovalDecision(input: ApprovalRequestInput): ApprovalRecord | null {
  const fingerprint = fingerprintApproval(input);
  return readApprovalQueue().records
    .map(normalizeRecord)
    .find(record => record.fingerprint === fingerprint) ?? null;
}

export function isApprovalGranted(input: ApprovalRequestInput): boolean {
  return getApprovalDecision(input)?.status === 'approved';
}

export function dependencyInstallApprovalInput(
  input: DependencyInstallApprovalInput,
): ApprovalRequestInput {
  const command = input.command.trim();
  if (!command) {
    throw new Error('Dependency install approval requires a non-empty command.');
  }

  return {
    kind: 'dependency_install',
    summary: `Approve dependency install: ${command}`,
    reason: 'Dependency installation can mutate the workspace and download code; example_autonomous_agent manager requires explicit approval.',
    scope: {
      projectRoot: input.projectRoot ?? null,
      executionProfile: input.executionProfile ?? 'opencalw_manager',
    },
    payload: {
      command,
    },
  };
}

export function requestDependencyInstallApproval(
  input: DependencyInstallApprovalInput,
): ApprovalRequestResult {
  return createOrReuseApprovalRequest(dependencyInstallApprovalInput(input));
}

export function isDependencyInstallApproved(input: DependencyInstallApprovalInput): boolean {
  return isApprovalGranted(dependencyInstallApprovalInput(input));
}

export function getDependencyInstallApprovalDecision(input: DependencyInstallApprovalInput): ApprovalRecord | null {
  return getApprovalDecision(dependencyInstallApprovalInput(input));
}

export function modelEscalationApprovalInput(input: ModelEscalationApprovalInput): ApprovalRequestInput {
  const task = input.task.trim();
  if (!task) {
    throw new Error('Model escalation approval requires non-empty task text.');
  }

  const model = input.model?.trim() || 'policy-default';
  const modelTier = input.modelTier?.trim() || 'policy-default';
  return {
    kind: 'model_escalation',
    summary: `Approve model escalation: ${model} / ${modelTier}`,
    reason: 'Model escalation can increase cost and autonomy. Interactive CLI model flags approve one run; queued approvals are for unattended or repeated escalation.',
    scope: {
      projectRoot: input.projectRoot ?? null,
      executionProfile: 'opencalw_manager',
    },
    payload: {
      task,
      model,
      model_tier: modelTier,
    },
  };
}

export function requestModelEscalationApproval(input: ModelEscalationApprovalInput): ApprovalRequestResult {
  return createOrReuseApprovalRequest(modelEscalationApprovalInput(input));
}

export function isModelEscalationApproved(input: ModelEscalationApprovalInput): boolean {
  return isApprovalGranted(modelEscalationApprovalInput(input));
}

export function formatApprovalHuman(record: ApprovalRecord): string {
  return [
    `${record.id}  ${record.status}  ${record.kind}`,
    `  Summary: ${record.summary}`,
    `  Scope: ${record.scope.project_root ?? '(global)'} / ${record.scope.execution_profile ?? '(any profile)'}`,
    `  Requested: ${record.requested_at}`,
    `  Expires: ${record.expires_at ?? '(not approved)'}`,
  ].join('\n');
}

export function formatApprovalListHuman(records: ApprovalRecord[]): string {
  if (records.length === 0) {
    return 'No approval requests found.';
  }
  return records.map(formatApprovalHuman).join('\n\n');
}

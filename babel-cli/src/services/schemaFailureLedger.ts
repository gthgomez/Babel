import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EvidenceBundle } from '../evidence.js';
import type { RunnerInvocationMetadata } from '../runners/base.js';
import { redactEvidenceValue, redactSecrets } from '../utils/redaction.js';

export const SCHEMA_FAILURE_LEDGER_FILENAME = '08_schema_failures.jsonl';
export const SCHEMA_FAILURE_ARTIFACT_DIR = 'schema_failures';
export const SCHEMA_LEARNING_DIR = '_schema_learning';
export const SCHEMA_SHADOW_HINTS_FILENAME = 'schema_shadow_hints.json';

export type SchemaFailureKind =
  | 'empty_response'
  | 'invalid_json'
  | 'failed_to_parse_api_json'
  | 'zod_validation_failed'
  | 'unknown_structured_output_failure';

export type SchemaFailureStorageMode = 'raw_local' | 'redacted';

export type SchemaFailureRetryOutcome =
  | 'pending_retry'
  | 'recovered'
  | 'cascaded'
  | 'fatal';

export interface SchemaIssueSummary {
  path: Array<string | number>;
  code: string;
  message: string;
}

export interface SchemaFailureLedgerEntry {
  schema_version: 1;
  artifact_type: 'babel_schema_failure';
  entry_id: string;
  generated_at: string;
  run_id: string;
  run_dir: string;
  stage: string;
  schema_name: string;
  provider: string | null;
  model: string | null;
  tier_name: string;
  tier_index: number;
  attempt: number;
  failure_kind: SchemaFailureKind;
  retry_outcome: SchemaFailureRetryOutcome;
  zod_issues: SchemaIssueSummary[];
  signature: string;
  prompt_sha256: string;
  raw_output_sha256: string | null;
  parsed_output_sha256: string | null;
  raw_output_path: string | null;
  parsed_output_path: string | null;
  retry_prompt_path: string | null;
  recommended_next_action: string;
  error_message: string;
  metadata: RunnerInvocationMetadata | null;
  recovered_schema_failure_entry_ids?: string[];
}

export interface SchemaShadowHint {
  schema_version: 1;
  artifact_type: 'babel_schema_shadow_hint';
  signature: string;
  stage: string;
  schema_name: string;
  failure_kind: SchemaFailureKind;
  hint: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  status: 'shadow';
  source_entry_ids: string[];
}

interface SchemaShadowHintFile {
  schema_version: 1;
  artifact_type: 'babel_schema_shadow_hints';
  generated_at: string;
  hints: SchemaShadowHint[];
}

interface StructuredOutputErrorLike extends Error {
  structuredOutputFailure?: true;
  failure_kind?: SchemaFailureKind;
  failureKind?: SchemaFailureKind;
  provider?: string | null;
  model?: string | null;
  provider_model_id?: string | null;
  raw_output?: string | null;
  rawOutput?: string | null;
  parsed_json?: unknown;
  parsedJson?: unknown;
  zod_issues?: unknown;
  zodIssues?: unknown;
}

export interface AppendSchemaFailureInput {
  evidence: EvidenceBundle;
  stage: string;
  schemaName: string;
  tierName: string;
  tierIndex: number;
  attempt: number;
  prompt: string;
  error: Error;
  metadata: RunnerInvocationMetadata | null;
  retryOutcome: SchemaFailureRetryOutcome;
  retryPrompt?: string | null;
}

export interface AppendSchemaFailureRecoveryInput {
  evidence: EvidenceBundle;
  stage: string;
  schemaName: string;
  tierName: string;
  tierIndex: number;
  attempt: number;
  prompt: string;
  metadata: RunnerInvocationMetadata | null;
  recoveredEntryIds: string[];
}

export interface AppendSchemaFailureTerminalInput {
  evidence: EvidenceBundle;
  stage: string;
  schemaName: string;
  prompt: string;
  metadata: RunnerInvocationMetadata | null;
  relatedEntryIds: string[];
  retryOutcome: Extract<SchemaFailureRetryOutcome, 'fatal' | 'cascaded'>;
  errorMessage: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

function stringifyArtifact(value: unknown): string {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeStorageMode(value: string | undefined): SchemaFailureStorageMode {
  return value === 'redacted' ? 'redacted' : 'raw_local';
}

export function getSchemaFailureStorageMode(): SchemaFailureStorageMode {
  return normalizeStorageMode(process.env['BABEL_SCHEMA_FAILURE_STORAGE']);
}

function structuredError(error: Error): StructuredOutputErrorLike {
  return error as StructuredOutputErrorLike;
}

function getFailureKind(error: Error): SchemaFailureKind {
  const candidate = structuredError(error);
  if (candidate.failure_kind) return candidate.failure_kind;
  if (candidate.failureKind) return candidate.failureKind;
  const message = error.message.toLowerCase();
  if (message.includes('empty response')) return 'empty_response';
  if (candidate.failure_kind === 'failed_to_parse_api_json') return 'failed_to_parse_api_json';
  if (message.includes('failed to parse api response as json')) return 'failed_to_parse_api_json';
  if (message.includes('invalid json')) return 'invalid_json';
  if (message.includes('zod validation failed')) return 'zod_validation_failed';
  return 'unknown_structured_output_failure';
}

function getRawOutput(error: Error): string | null {
  const candidate = structuredError(error);
  const raw = candidate.raw_output ?? candidate.rawOutput;
  return typeof raw === 'string' ? raw : null;
}

function getParsedOutput(error: Error): unknown {
  const candidate = structuredError(error);
  if ('parsed_json' in candidate) return candidate.parsed_json;
  if ('parsedJson' in candidate) return candidate.parsedJson;
  return undefined;
}

function issueFromUnknown(value: unknown): SchemaIssueSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rawPath = Array.isArray(record['path']) ? record['path'] : [];
  return {
    path: rawPath.filter((entry): entry is string | number =>
      typeof entry === 'string' || typeof entry === 'number',
    ),
    code: typeof record['code'] === 'string' ? record['code'] : 'unknown',
    message: typeof record['message'] === 'string' ? record['message'] : String(value),
  };
}

function getZodIssues(error: Error): SchemaIssueSummary[] {
  const candidate = structuredError(error);
  const rawIssues = candidate.zod_issues ?? candidate.zodIssues;
  if (Array.isArray(rawIssues)) {
    return rawIssues.map(issueFromUnknown).filter((issue): issue is SchemaIssueSummary => issue !== null);
  }
  if (rawIssues && typeof rawIssues === 'object' && Array.isArray((rawIssues as { issues?: unknown }).issues)) {
    return (rawIssues as { issues: unknown[] }).issues
      .map(issueFromUnknown)
      .filter((issue): issue is SchemaIssueSummary => issue !== null);
  }

  const pathMatches = [...error.message.matchAll(/"path":\s*\[([^\]]*)\][\s\S]*?"message":\s*"([^"]+)"/g)];
  return pathMatches.map((match) => ({
    path: (match[1] ?? '')
      .split(',')
      .map(part => part.trim().replace(/^"|"$/g, ''))
      .filter(Boolean),
    code: 'unknown',
    message: match[2] ?? 'Zod validation failed',
  }));
}

function getProvider(error: Error, metadata: RunnerInvocationMetadata | null): string | null {
  const candidate = structuredError(error);
  return candidate.provider ?? metadata?.provider ?? null;
}

function getModel(error: Error, metadata: RunnerInvocationMetadata | null): string | null {
  const candidate = structuredError(error);
  return candidate.model ?? candidate.provider_model_id ?? metadata?.provider_model_id ?? null;
}

function issueSignature(issues: SchemaIssueSummary[]): string {
  if (issues.length === 0) return 'no_zod_issue_path';
  return issues
    .map(issue => `${issue.path.join('.') || '<root>'}:${issue.code}:${issue.message}`)
    .sort()
    .join('|');
}

export function buildSchemaFailureSignature(input: {
  stage: string;
  schemaName: string;
  failureKind: SchemaFailureKind;
  zodIssues: SchemaIssueSummary[];
}): string {
  return [
    input.stage,
    input.schemaName,
    input.failureKind,
    issueSignature(input.zodIssues),
  ].join('::');
}

export function recommendSchemaFailureAction(input: {
  stage: string;
  schemaName: string;
  failureKind: SchemaFailureKind;
  zodIssues: SchemaIssueSummary[];
}): string {
  const paths = input.zodIssues.map(issue => issue.path.join('.'));
  if (input.stage === 'orchestrator' && paths.includes('swarm.sub_tasks')) {
    return 'Omit swarm unless pipeline_mode is parallel_swarm; empty swarm.sub_tasks is normalized to absent swarm.';
  }
  if (input.failureKind === 'empty_response') {
    return 'Retry with a terse raw-JSON-only prompt and inspect provider token limits or empty completion behavior if it repeats.';
  }
  if (input.failureKind === 'invalid_json' || input.failureKind === 'failed_to_parse_api_json') {
    return 'Retry with raw JSON only; compare raw output against extractor behavior before changing model policy.';
  }
  if (input.stage === 'qa') {
    return 'Use the strict QA verdict shape: PASS has no failure list; REJECT includes at least one failure with actionable evidence.';
  }
  if (input.stage === 'executor') {
    return 'Use one valid executor discriminator shape: tool_call, completion, or halt; do not mix fields across variants.';
  }
  return 'Inspect the schema issue path and add either a schema normalizer or a stage-specific retry hint before changing models.';
}

function ensureArtifactDir(runDir: string): string {
  const artifactDir = join(runDir, SCHEMA_FAILURE_ARTIFACT_DIR);
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

function writeSideArtifact(input: {
  evidence: EvidenceBundle;
  entryId: string;
  suffix: string;
  content: unknown;
  storageMode: SchemaFailureStorageMode;
}): { path: string | null; hash: string | null } {
  if (input.content === undefined || input.content === null) {
    return { path: null, hash: null };
  }

  const serialized = stringifyArtifact(input.content);
  const hash = sha256(serialized);
  if (input.storageMode === 'redacted') {
    return { path: null, hash };
  }

  const artifactDir = ensureArtifactDir(input.evidence.runDir);
  const path = join(artifactDir, `${input.entryId}_${input.suffix}`);
  const redacted = redactSecrets(serialized);
  writeFileSync(path, redacted, 'utf-8');
  return { path, hash };
}

function appendLedgerEntry(evidence: EvidenceBundle, entry: SchemaFailureLedgerEntry): void {
  const path = join(evidence.runDir, SCHEMA_FAILURE_LEDGER_FILENAME);
  const redacted = redactEvidenceValue(entry);
  appendFileSync(path, `${JSON.stringify(redacted)}\n`, 'utf-8');
}

function hintsPathForEvidence(evidence: EvidenceBundle): string {
  return join(dirname(evidence.runDir), SCHEMA_LEARNING_DIR, SCHEMA_SHADOW_HINTS_FILENAME);
}

function readHintFile(path: string): SchemaShadowHintFile {
  if (!existsSync(path)) {
    return {
      schema_version: 1,
      artifact_type: 'babel_schema_shadow_hints',
      generated_at: new Date().toISOString(),
      hints: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SchemaShadowHintFile>;
    return {
      schema_version: 1,
      artifact_type: 'babel_schema_shadow_hints',
      generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : new Date().toISOString(),
      hints: Array.isArray(parsed.hints) ? parsed.hints as SchemaShadowHint[] : [],
    };
  } catch {
    return {
      schema_version: 1,
      artifact_type: 'babel_schema_shadow_hints',
      generated_at: new Date().toISOString(),
      hints: [],
    };
  }
}

function writeHintFile(path: string, file: SchemaShadowHintFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redactEvidenceValue(file), null, 2)}\n`, 'utf-8');
}

export function recordSchemaShadowHint(
  evidence: EvidenceBundle,
  entry: Pick<SchemaFailureLedgerEntry,
    'entry_id' | 'signature' | 'stage' | 'schema_name' | 'failure_kind' | 'recommended_next_action'>,
): SchemaShadowHint {
  const path = hintsPathForEvidence(evidence);
  const file = readHintFile(path);
  const now = new Date().toISOString();
  const existing = file.hints.find(hint => hint.signature === entry.signature);

  if (existing) {
    existing.count += 1;
    existing.last_seen_at = now;
    existing.hint = entry.recommended_next_action;
    if (!existing.source_entry_ids.includes(entry.entry_id)) {
      existing.source_entry_ids.push(entry.entry_id);
    }
    file.generated_at = now;
    writeHintFile(path, file);
    return existing;
  }

  const hint: SchemaShadowHint = {
    schema_version: 1,
    artifact_type: 'babel_schema_shadow_hint',
    signature: entry.signature,
    stage: entry.stage,
    schema_name: entry.schema_name,
    failure_kind: entry.failure_kind,
    hint: entry.recommended_next_action,
    count: 1,
    first_seen_at: now,
    last_seen_at: now,
    status: 'shadow',
    source_entry_ids: [entry.entry_id],
  };
  file.hints.push(hint);
  file.generated_at = now;
  writeHintFile(path, file);
  return hint;
}

export function readSchemaShadowHints(input: {
  evidence?: EvidenceBundle;
  stage: string;
  schemaName: string;
  limit?: number;
}): string[] {
  if (!input.evidence) return [];
  const file = readHintFile(hintsPathForEvidence(input.evidence));
  const limit = input.limit ?? 3;
  return file.hints
    .filter(hint =>
      hint.status === 'shadow' &&
      hint.stage === input.stage &&
      hint.schema_name === input.schemaName,
    )
    .sort((left, right) => right.count - left.count || right.last_seen_at.localeCompare(left.last_seen_at))
    .slice(0, limit)
    .map(hint => hint.hint);
}

export function appendSchemaFailureEntry(input: AppendSchemaFailureInput): SchemaFailureLedgerEntry {
  const failureKind = getFailureKind(input.error);
  const zodIssues = getZodIssues(input.error);
  const signature = buildSchemaFailureSignature({
    stage: input.stage,
    schemaName: input.schemaName,
    failureKind,
    zodIssues,
  });
  const entryId = `schema_failure_${Date.now()}_${shortHash([
    input.evidence.runId,
    input.stage,
    input.schemaName,
    input.tierName,
    String(input.attempt),
    signature,
  ].join('|'))}`;
  const storageMode = getSchemaFailureStorageMode();
  const rawOutput = getRawOutput(input.error);
  const parsedOutput = getParsedOutput(input.error);
  const rawArtifact = writeSideArtifact({
    evidence: input.evidence,
    entryId,
    suffix: 'raw_output.txt',
    content: rawOutput,
    storageMode,
  });
  const parsedArtifact = writeSideArtifact({
    evidence: input.evidence,
    entryId,
    suffix: 'parsed_output.json',
    content: parsedOutput,
    storageMode,
  });
  const retryArtifact = writeSideArtifact({
    evidence: input.evidence,
    entryId,
    suffix: 'retry_prompt.md',
    content: input.retryPrompt ?? null,
    storageMode,
  });

  const entry: SchemaFailureLedgerEntry = {
    schema_version: 1,
    artifact_type: 'babel_schema_failure',
    entry_id: entryId,
    generated_at: new Date().toISOString(),
    run_id: input.evidence.runId,
    run_dir: input.evidence.runDir,
    stage: input.stage,
    schema_name: input.schemaName,
    provider: getProvider(input.error, input.metadata),
    model: getModel(input.error, input.metadata),
    tier_name: input.tierName,
    tier_index: input.tierIndex,
    attempt: input.attempt,
    failure_kind: failureKind,
    retry_outcome: input.retryOutcome,
    zod_issues: zodIssues,
    signature,
    prompt_sha256: sha256(input.prompt),
    raw_output_sha256: rawArtifact.hash,
    parsed_output_sha256: parsedOutput === undefined ? null : sha256(stableJson(parsedOutput)),
    raw_output_path: rawArtifact.path,
    parsed_output_path: parsedArtifact.path,
    retry_prompt_path: retryArtifact.path,
    recommended_next_action: recommendSchemaFailureAction({
      stage: input.stage,
      schemaName: input.schemaName,
      failureKind,
      zodIssues,
    }),
    error_message: input.error.message,
    metadata: input.metadata,
  };

  appendLedgerEntry(input.evidence, entry);
  recordSchemaShadowHint(input.evidence, entry);
  return entry;
}

export function appendSchemaFailureRecovery(input: AppendSchemaFailureRecoveryInput): SchemaFailureLedgerEntry {
  const signature = buildSchemaFailureSignature({
    stage: input.stage,
    schemaName: input.schemaName,
    failureKind: 'unknown_structured_output_failure',
    zodIssues: [],
  });
  const entryId = `schema_failure_recovery_${Date.now()}_${shortHash(input.recoveredEntryIds.join('|'))}`;
  const entry: SchemaFailureLedgerEntry = {
    schema_version: 1,
    artifact_type: 'babel_schema_failure',
    entry_id: entryId,
    generated_at: new Date().toISOString(),
    run_id: input.evidence.runId,
    run_dir: input.evidence.runDir,
    stage: input.stage,
    schema_name: input.schemaName,
    provider: input.metadata?.provider ?? null,
    model: input.metadata?.provider_model_id ?? null,
    tier_name: input.tierName,
    tier_index: input.tierIndex,
    attempt: input.attempt,
    failure_kind: 'unknown_structured_output_failure',
    retry_outcome: 'recovered',
    zod_issues: [],
    signature,
    prompt_sha256: sha256(input.prompt),
    raw_output_sha256: null,
    parsed_output_sha256: null,
    raw_output_path: null,
    parsed_output_path: null,
    retry_prompt_path: null,
    recommended_next_action: 'Recovered after structured-output retry or fallback; compare recovered entry ids for the effective repair path.',
    error_message: 'Recovered after prior structured-output failure.',
    metadata: input.metadata,
    recovered_schema_failure_entry_ids: input.recoveredEntryIds,
  };

  appendLedgerEntry(input.evidence, entry);
  return entry;
}

export function appendSchemaFailureTerminal(input: AppendSchemaFailureTerminalInput): SchemaFailureLedgerEntry {
  const signature = buildSchemaFailureSignature({
    stage: input.stage,
    schemaName: input.schemaName,
    failureKind: 'unknown_structured_output_failure',
    zodIssues: [],
  });
  const entryId = `schema_failure_${input.retryOutcome}_${Date.now()}_${shortHash(input.relatedEntryIds.join('|'))}`;
  const entry: SchemaFailureLedgerEntry = {
    schema_version: 1,
    artifact_type: 'babel_schema_failure',
    entry_id: entryId,
    generated_at: new Date().toISOString(),
    run_id: input.evidence.runId,
    run_dir: input.evidence.runDir,
    stage: input.stage,
    schema_name: input.schemaName,
    provider: input.metadata?.provider ?? null,
    model: input.metadata?.provider_model_id ?? null,
    tier_name: 'waterfall',
    tier_index: -1,
    attempt: 0,
    failure_kind: 'unknown_structured_output_failure',
    retry_outcome: input.retryOutcome,
    zod_issues: [],
    signature,
    prompt_sha256: sha256(input.prompt),
    raw_output_sha256: null,
    parsed_output_sha256: null,
    raw_output_path: null,
    parsed_output_path: null,
    retry_prompt_path: null,
    recommended_next_action: 'Structured-output failures exhausted retry/fallback; inspect related entry ids and add a schema normalizer, stricter retry hint, or provider-specific output repair.',
    error_message: input.errorMessage,
    metadata: input.metadata,
    recovered_schema_failure_entry_ids: input.relatedEntryIds,
  };

  appendLedgerEntry(input.evidence, entry);
  return entry;
}

/**
 * T5.1 — Verified-completion contract.
 *
 * Normalizes chat/benchmark completion evidence into a publishable artifact
 * and structurally validates it (no external JSON Schema engine required).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERIFIED_COMPLETION_SCHEMA_VERSION = 1 as const;
export const VERIFIED_COMPLETION_ARTIFACT_TYPE = 'babel_verified_completion' as const;

export interface VerifierReceipt {
  command: string;
  exit_code: number;
  summary: string;
}

export interface VerifiedCompletion {
  schema_version: typeof VERIFIED_COMPLETION_SCHEMA_VERSION;
  artifact_type: typeof VERIFIED_COMPLETION_ARTIFACT_TYPE;
  generated_at?: string;
  status: string;
  task?: string | null;
  project?: string | null;
  run_dir: string | null;
  changed_files: string[];
  verifier_receipt?: VerifierReceipt | null;
  false_complete?: boolean;
  failure_class?: string | null;
  tool_call_summary?: {
    total?: number;
    writes?: number;
    reads?: number;
    verifier_attempts?: number;
  };
  blocked_report?: unknown;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    cost_usd?: number | null;
  };
  evidence_paths?: Record<string, string>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ALLOWED_STATUS = new Set([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'ANSWER_READY',
  'BLOCKED',
  'NEEDS_MORE_CONTEXT',
]);

/** Absolute path to the published JSON Schema (repo-relative from babel-cli). */
export function verifiedCompletionSchemaPath(repoRoot?: string): string {
  const root =
    repoRoot ??
    process.env['BABEL_ROOT'] ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(root, 'benchmarks', 'schemas', 'verified-completion.schema.json');
}

export function verifiedCompletionExamplePath(repoRoot?: string): string {
  const root =
    repoRoot ??
    process.env['BABEL_ROOT'] ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(root, 'benchmarks', 'schemas', 'examples', 'verified-completion.example.json');
}

export function validateVerifiedCompletion(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['payload must be a non-null object'] };
  }
  const o = value as Record<string, unknown>;

  if (o['schema_version'] !== 1) {
    errors.push('schema_version must be 1');
  }
  if (o['artifact_type'] !== VERIFIED_COMPLETION_ARTIFACT_TYPE) {
    errors.push(`artifact_type must be "${VERIFIED_COMPLETION_ARTIFACT_TYPE}"`);
  }
  if (typeof o['status'] !== 'string' || !ALLOWED_STATUS.has(o['status'])) {
    errors.push(`status must be one of: ${[...ALLOWED_STATUS].join(', ')}`);
  }
  if (!('run_dir' in o)) {
    errors.push('run_dir is required (string or null)');
  } else if (o['run_dir'] !== null && typeof o['run_dir'] !== 'string') {
    errors.push('run_dir must be string or null');
  }
  if (!Array.isArray(o['changed_files'])) {
    errors.push('changed_files must be an array of strings');
  } else if (!o['changed_files'].every((f) => typeof f === 'string' && f.length > 0)) {
    errors.push('changed_files entries must be non-empty strings');
  }

  if ('verifier_receipt' in o && o['verifier_receipt'] != null) {
    const vr = o['verifier_receipt'];
    if (!vr || typeof vr !== 'object' || Array.isArray(vr)) {
      errors.push('verifier_receipt must be object or null');
    } else {
      const r = vr as Record<string, unknown>;
      if (typeof r['command'] !== 'string' || r['command'].length === 0) {
        errors.push('verifier_receipt.command must be a non-empty string');
      }
      if (typeof r['exit_code'] !== 'number' || !Number.isInteger(r['exit_code'])) {
        errors.push('verifier_receipt.exit_code must be an integer');
      }
      if (typeof r['summary'] !== 'string') {
        errors.push('verifier_receipt.summary must be a string');
      }
    }
  }

  if ('false_complete' in o && o['false_complete'] !== undefined && typeof o['false_complete'] !== 'boolean') {
    errors.push('false_complete must be boolean when present');
  }

  return { ok: errors.length === 0, errors };
}

export function buildVerifiedCompletion(input: {
  status: string;
  run_dir?: string | null;
  changed_files?: string[];
  verifier_receipt?: VerifierReceipt | null;
  task?: string | null;
  project?: string | null;
  false_complete?: boolean;
  failure_class?: string | null;
  tool_call_summary?: VerifiedCompletion['tool_call_summary'];
  blocked_report?: unknown;
  usage?: VerifiedCompletion['usage'];
  evidence_paths?: Record<string, string>;
  generated_at?: string;
}): VerifiedCompletion {
  return {
    schema_version: VERIFIED_COMPLETION_SCHEMA_VERSION,
    artifact_type: VERIFIED_COMPLETION_ARTIFACT_TYPE,
    generated_at: input.generated_at ?? new Date().toISOString(),
    status: input.status,
    task: input.task ?? null,
    project: input.project ?? null,
    run_dir: input.run_dir ?? null,
    changed_files: input.changed_files ?? [],
    verifier_receipt: input.verifier_receipt ?? null,
    false_complete: input.false_complete ?? false,
    failure_class: input.failure_class ?? null,
    ...(input.tool_call_summary ? { tool_call_summary: input.tool_call_summary } : {}),
    blocked_report: input.blocked_report ?? null,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.evidence_paths ? { evidence_paths: input.evidence_paths } : {}),
  };
}

/** Load the published example and validate (sanity check for packaging). */
export function loadAndValidateExample(repoRoot?: string): ValidationResult {
  const path = verifiedCompletionExamplePath(repoRoot);
  if (!existsSync(path)) {
    return { ok: false, errors: [`example missing: ${path}`] };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateVerifiedCompletion(raw);
}

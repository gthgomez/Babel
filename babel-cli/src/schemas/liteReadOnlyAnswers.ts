import { z } from 'zod';

export type LiteReadOnlyAnswerMode = 'plan' | 'report';

let pendingNormalizations: string[] = [];

export function consumeLiteSchemaNormalizations(): string[] {
  const copy = [...pendingNormalizations];
  pendingNormalizations = [];
  return copy;
}

function recordNormalization(label: string): void {
  pendingNormalizations.push(label);
}

export function unwrapSingleObjectArray(value: unknown): unknown {
  return Array.isArray(value) &&
    value.length === 1 &&
    value[0] !== null &&
    typeof value[0] === 'object'
    ? value[0]
    : value;
}

const NEEDS_MORE_CONTEXT_ALIASES = new Set([
  'NEED_MORE_CONTEXT',
  'NEED_CONTEXT',
  'INSUFFICIENT_CONTEXT',
  'NEEDS_CONTEXT',
  'MORE_CONTEXT_NEEDED',
]);

const PLAN_READY_ALIASES = new Set(['READY', 'PLAN_COMPLETE', 'COMPLETE']);
const REPORT_READY_ALIASES = new Set(['READY', 'REPORT_COMPLETE', 'COMPLETE']);

export function normalizeLiteStatus(value: unknown, mode: LiteReadOnlyAnswerMode): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (NEEDS_MORE_CONTEXT_ALIASES.has(upper) || upper === 'NEEDS_MORE_CONTEXT') {
    if (upper !== 'NEEDS_MORE_CONTEXT') {
      recordNormalization(`status:${trimmed}->NEEDS_MORE_CONTEXT`);
    }
    return 'NEEDS_MORE_CONTEXT';
  }
  const readyAliases = mode === 'plan' ? PLAN_READY_ALIASES : REPORT_READY_ALIASES;
  const readyStatus = mode === 'plan' ? 'PLAN_READY' : 'REPORT_READY';
  if (readyAliases.has(upper) || upper === readyStatus) {
    if (upper !== readyStatus && upper !== readyStatus.replace('_', ' ')) {
      recordNormalization(`status:${trimmed}->${readyStatus}`);
    }
    return readyStatus;
  }
  if (trimmed !== upper && (upper === readyStatus || NEEDS_MORE_CONTEXT_ALIASES.has(upper))) {
    recordNormalization(`status:${trimmed}->${upper}`);
    return upper;
  }
  return trimmed;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const match = trimmed.match(/^[\s\S]*?[.!?](?:\s|$)/);
  const sentence = match ? match[0].trim() : trimmed;
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

export function deriveSummaryFromAnswer(record: Record<string, unknown>): void {
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  const answer = typeof record['answer'] === 'string' ? record['answer'].trim() : '';
  if (summary.length === 0 && answer.length > 0) {
    record['summary'] = firstSentence(answer);
    recordNormalization('summary:derived_from_answer');
  }
}

export function normalizeLiteReadOnlyAnswer(value: unknown, mode: LiteReadOnlyAnswerMode): unknown {
  const unwrapped = unwrapSingleObjectArray(value);
  if (unwrapped !== value) {
    recordNormalization('unwrap_single_object_array');
  }
  if (unwrapped === null || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    return unwrapped;
  }

  const record = structuredClone(unwrapped as Record<string, unknown>);
  if (record['schema_version'] === undefined) {
    record['schema_version'] = 1;
    recordNormalization('schema_version:defaulted_to_1');
  }
  if (record['status'] !== undefined) {
    record['status'] = normalizeLiteStatus(record['status'], mode);
  }
  deriveSummaryFromAnswer(record);
  return record;
}

const planDescriptiveKeys = [
  'description',
  'step',
  'action',
  'title',
  'summary',
  'path',
  'file',
  'name',
  'command',
];
const reportDescriptiveKeys = [
  'finding',
  'description',
  'summary',
  'detail',
  'path',
  'file',
  'name',
  'command',
  'next',
];

export function createDescriptiveString(keys: string[]) {
  return z.preprocess((value) => {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          return candidate;
        }
      }
    }
    return value;
  }, z.string().min(1));
}

export const planDescriptiveString = createDescriptiveString(planDescriptiveKeys);
export const reportDescriptiveString = createDescriptiveString(reportDescriptiveKeys);

export function createDescriptiveStringArray(descriptiveString: z.ZodTypeAny) {
  return z.array(descriptiveString).default([]);
}

export const LitePlanAnswerObjectSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['PLAN_READY', 'NEEDS_MORE_CONTEXT']),
  summary: z.string().min(1),
  answer: z.string().min(1),
  steps: createDescriptiveStringArray(planDescriptiveString),
  likely_files: createDescriptiveStringArray(planDescriptiveString),
  risks: createDescriptiveStringArray(planDescriptiveString),
  verification: createDescriptiveStringArray(planDescriptiveString),
  next: createDescriptiveStringArray(planDescriptiveString),
});

export const LiteReportAnswerObjectSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['REPORT_READY', 'NEEDS_MORE_CONTEXT']),
  summary: z.string().min(1),
  answer: z.string().min(1),
  findings: createDescriptiveStringArray(reportDescriptiveString),
  inspected: createDescriptiveStringArray(reportDescriptiveString),
  limitations: createDescriptiveStringArray(reportDescriptiveString),
  verification: createDescriptiveStringArray(reportDescriptiveString),
  next: createDescriptiveStringArray(reportDescriptiveString),
});

export const LitePlanAnswerSchema = z.preprocess(
  (value) => normalizeLiteReadOnlyAnswer(value, 'plan'),
  LitePlanAnswerObjectSchema,
);

export const LiteReportAnswerSchema = z.preprocess(
  (value) => normalizeLiteReadOnlyAnswer(value, 'report'),
  LiteReportAnswerObjectSchema,
);

export const LitePlanReviewObjectSchema = z.object({
  schema_version: z.literal(1),
  verdict: z.enum(['APPROVE', 'REVISE', 'REJECT']),
  summary: z.string().min(1),
  findings: createDescriptiveStringArray(planDescriptiveString),
  risks: createDescriptiveStringArray(planDescriptiveString),
  suggested_changes: createDescriptiveStringArray(planDescriptiveString),
});

export const LitePlanReviewSchema = z.preprocess(
  (value) => normalizeLiteReadOnlyAnswer(value, 'plan'),
  LitePlanReviewObjectSchema,
);

export type LitePlanAnswer = z.infer<typeof LitePlanAnswerObjectSchema>;
export type LiteReportAnswer = z.infer<typeof LiteReportAnswerObjectSchema>;
export type LitePlanReview = z.infer<typeof LitePlanReviewObjectSchema>;

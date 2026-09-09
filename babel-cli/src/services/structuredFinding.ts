import { createHash } from 'node:crypto';
import { z } from 'zod';

export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'trust_authority'
  | 'concurrency'
  | 'portability'
  | 'failure_safety'
  | 'api_compatibility'
  | 'spec_conformance'
  | 'tests';

export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';
export type FindingConfidence = 'high' | 'medium' | 'low';

export type VerificationStatus =
  | 'UNVERIFIED'
  | 'CONFIRMED'
  | 'REJECTED_FALSE_POSITIVE'
  | 'INCONCLUSIVE'
  | 'DUPLICATE'
  | 'SUPERSEDED';

export interface FindingLocation {
  path: string;
  line?: number;
  end_line?: number;
  symbol?: string;
}

export interface StructuredFinding {
  schema_version: 2;
  finding_instance_id: string;
  finding_fingerprint: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  location: FindingLocation;
  claim: string;
  proposed_reproduction?: string;
  reviewer_id: string;
  recommended_blocking: boolean;
  policy_blocking: boolean;
  verification_status: VerificationStatus;
  verification_source?: string;
  evidence_refs?: string[];
  created_at: string;
}

export const StructuredFindingSchema = z.object({
  schema_version: z.literal(2).default(2),
  finding_instance_id: z.string().regex(/^[a-f0-9]{64}$/),
  finding_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  category: z.enum([
    'correctness',
    'security',
    'trust_authority',
    'concurrency',
    'portability',
    'failure_safety',
    'api_compatibility',
    'spec_conformance',
    'tests',
  ]),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.enum(['high', 'medium', 'low']),
  location: z.object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    symbol: z.string().optional(),
  }),
  claim: z.string().min(1).max(4000),
  proposed_reproduction: z.string().max(4000).optional(),
  reviewer_id: z.string().min(1),
  recommended_blocking: z.boolean(),
  policy_blocking: z.boolean(),
  verification_status: z.enum([
    'UNVERIFIED',
    'CONFIRMED',
    'REJECTED_FALSE_POSITIVE',
    'INCONCLUSIVE',
    'DUPLICATE',
    'SUPERSEDED',
  ]),
  verification_source: z.string().optional(),
  evidence_refs: z.array(z.string()).optional(),
  created_at: z.string(),
});

export function computeFindingInstanceId(input: {
  candidateDigest: string;
  executionId: string;
  rawClaim: string;
  reviewerId: string;
}): string {
  const payload = [input.candidateDigest, input.executionId, input.reviewerId, input.rawClaim.trim()];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function computeFindingFingerprint(input: {
  category: FindingCategory;
  path: string;
  lineSpan?: string | undefined;
  defectClass?: string | undefined;
}): string {
  const normPath = input.path.replace(/\\/g, '/').toLowerCase();
  const payload = [
    input.category,
    normPath,
    input.lineSpan ?? '',
    input.defectClass ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createStructuredFinding(input: {
  candidateDigest: string;
  executionId: string;
  reviewerId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence?: FindingConfidence;
  path: string;
  line?: number;
  end_line?: number;
  symbol?: string;
  claim: string;
  proposed_reproduction?: string;
  recommended_blocking?: boolean;
  policy_blocking?: boolean;
  defectClass?: string;
  now?: string;
}): StructuredFinding {
  const now = input.now ?? new Date().toISOString();
  const normPath = input.path.replace(/\\/g, '/').replace(/^source\//, '');
  const lineSpan = input.line ? `${input.line}-${input.end_line ?? input.line}` : undefined;

  const instanceId = computeFindingInstanceId({
    candidateDigest: input.candidateDigest,
    executionId: input.executionId,
    rawClaim: input.claim,
    reviewerId: input.reviewerId,
  });

  const fingerprint = computeFindingFingerprint({
    category: input.category,
    path: normPath,
    lineSpan,
    defectClass: input.defectClass,
  });

  const recBlocking = input.recommended_blocking ?? (input.severity === 'P0' || input.severity === 'P1');
  const polBlocking = input.policy_blocking ?? recBlocking;

  return {
    schema_version: 2,
    finding_instance_id: instanceId,
    finding_fingerprint: fingerprint,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence ?? 'high',
    location: {
      path: normPath,
      ...(input.line ? { line: input.line } : {}),
      ...(input.end_line ? { end_line: input.end_line } : {}),
      ...(input.symbol ? { symbol: input.symbol } : {}),
    },
    claim: input.claim,
    ...(input.proposed_reproduction ? { proposed_reproduction: input.proposed_reproduction } : {}),
    reviewer_id: input.reviewerId,
    recommended_blocking: recBlocking,
    policy_blocking: polBlocking,
    verification_status: 'UNVERIFIED',
    created_at: now,
  };
}

export function deduplicateFindings(findings: StructuredFinding[]): StructuredFinding[] {
  const byFingerprint = new Map<string, StructuredFinding>();

  for (const finding of findings) {
    const existing = byFingerprint.get(finding.finding_fingerprint);
    if (!existing) {
      byFingerprint.set(finding.finding_fingerprint, finding);
    } else {
      // Keep the one with higher severity or confirmed verification
      if (
        (finding.verification_status === 'CONFIRMED' && existing.verification_status !== 'CONFIRMED') ||
        finding.severity === 'P0' ||
        (finding.severity === 'P1' && existing.severity !== 'P0')
      ) {
        byFingerprint.set(finding.finding_fingerprint, finding);
      }
    }
  }

  return [...byFingerprint.values()];
}

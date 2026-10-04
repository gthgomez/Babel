/**
 * research/acquisition/evidenceValidator.ts — deterministic evidence gate
 *
 * The only code that may advance a claim to SOURCE_CONFIRMED. Validates
 * each EvidenceRef against the immutable snapshot: repository match,
 * commit match, path existence, blob/content hash match, line-range
 * existence, and bounded-excerpt byte equality. Invalid refs are removed,
 * not annotated — a model cannot promote its own unsupported claim.
 */

import { createHash } from 'node:crypto';
import type { EvidenceRefV1 } from '../contracts.js';
import type { RepositorySnapshot } from './snapshot.js';
import { excerptLines } from './snapshot.js';

export interface EvidenceValidationEntry {
  evidence_id: string;
  valid: boolean;
  reasons: string[];
}

export interface EvidenceValidationResult {
  valid: EvidenceRefV1[];
  invalid: EvidenceRefV1[];
  entries: EvidenceValidationEntry[];
}

function excerptHash(excerpt: string): string {
  return createHash('sha256').update(excerpt).digest('hex');
}

export function validateEvidenceRefs(
  snapshot: RepositorySnapshot,
  refs: EvidenceRefV1[],
): EvidenceValidationResult {
  const valid: EvidenceRefV1[] = [];
  const invalid: EvidenceRefV1[] = [];
  const entries: EvidenceValidationEntry[] = [];

  for (const ref of refs) {
    const reasons: string[] = [];

    if (ref.repository_id !== snapshot.manifest.repository_id) {
      reasons.push(`repository mismatch: ref ${ref.repository_id} vs snapshot ${snapshot.manifest.repository_id}`);
    }
    if (ref.commit_sha !== snapshot.manifest.commit_sha) {
      reasons.push(`commit mismatch: ref ${ref.commit_sha.slice(0, 8)} vs snapshot ${snapshot.manifest.commit_sha.slice(0, 8)}`);
    }
    const content = snapshot.files.get(ref.path);
    if (content === undefined) {
      reasons.push(`path not in snapshot: ${ref.path}`);
    } else {
      const file = snapshot.manifest.files.find((f) => f.path === ref.path);
      if (file && ref.blob_sha && file.blob_sha && ref.blob_sha !== file.blob_sha) {
        reasons.push('blob sha mismatch');
      }
      const lines = content.split('\n');
      const start = ref.start_line ?? 1;
      const end = ref.end_line ?? lines.length;
      const excerpt = excerptLines(content, start, end);
      if (excerpt === null) {
        reasons.push(`line range ${start}-${ref.end_line ?? '?'} outside file (${lines.length} lines)`);
      } else if (ref.content_hash !== excerptHash(excerpt)) {
        reasons.push('excerpt bytes do not match content hash');
      }
    }

    const entry: EvidenceValidationEntry = {
      evidence_id: ref.evidence_id,
      valid: reasons.length === 0,
      reasons,
    };
    entries.push(entry);
    if (entry.valid) {
      valid.push(ref);
    } else {
      invalid.push(ref);
    }
  }

  return { valid, invalid, entries };
}

/** Deterministic excerpt confirmation: does the pinned file contain these bytes at these lines? */
export function confirmExcerpt(
  snapshot: RepositorySnapshot,
  path: string,
  startLine: number,
  endLine: number,
): { excerpt: string; contentHash: string } | null {
  const content = snapshot.files.get(path);
  if (content === undefined) return null;
  const excerpt = excerptLines(content, startLine, endLine);
  if (excerpt === null) return null;
  return { excerpt, contentHash: excerptHash(excerpt) };
}

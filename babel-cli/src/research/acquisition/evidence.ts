/**
 * research/acquisition/evidence.ts — EvidenceRef construction
 *
 * Host-side factory for EvidenceRefV1 records. Refs are always created
 * against an existing immutable snapshot: the repository, commit, and
 * content metadata come from the snapshot manifest, never from a model.
 * Line ranges are optional and must never be fabricated by callers that
 * have not confirmed them (see evidenceValidator.confirmExcerpt).
 */

import { randomUUID } from 'node:crypto';
import type { EvidenceRefV1 } from '../contracts.js';
import type { RepositorySnapshot } from './snapshot.js';
import { sha256Hex } from './snapshot.js';

export interface CreateEvidenceRefInput {
  path: string;
  blobSha?: string;
  startLine?: number;
  endLine?: number;
  /** Explicit content hash when the ref targets a bounded excerpt. */
  contentHash?: string;
}

export function createEvidenceRef(snapshot: RepositorySnapshot, input: CreateEvidenceRefInput): EvidenceRefV1 | null {
  const entry = snapshot.manifest.files.find((file) => file.path === input.path);
  const content = snapshot.files.get(input.path);
  if (!entry || content === undefined) return null;
  return {
    schema_version: 1,
    evidence_id: `ev_${randomUUID().slice(0, 12)}`,
    repository_id: snapshot.manifest.repository_id,
    repository_full_name: snapshot.manifest.repository_full_name,
    commit_sha: snapshot.manifest.commit_sha,
    path: input.path,
    ...(input.blobSha !== undefined ? { blob_sha: input.blobSha } : {}),
    ...(input.startLine !== undefined ? { start_line: input.startLine } : {}),
    ...(input.endLine !== undefined ? { end_line: input.endLine } : {}),
    content_hash: input.contentHash ?? entry.content_hash ?? sha256Hex(content),
    acquisition_method: 'github_contents',
    observed_at: snapshot.manifest.created_at,
  };
}

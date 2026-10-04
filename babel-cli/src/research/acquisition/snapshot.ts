/**
 * research/acquisition/snapshot.ts — exact-SHA repository snapshots
 *
 * Acquires an immutable snapshot of one repository at one pinned commit:
 * resolve the revision first, record the SHA, fetch the tree, select a
 * bounded set of text files (manifests, license, docs, term-matched
 * source, tests), fetch only those, and persist a manifest with per-file
 * content hashes. Selected file contents are held in memory for the
 * analysis session; raw remote files are never copied into permanent
 * evidence (bounded excerpts plus hashes are).
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  RepositoryIdentity,
  RepositoryResearchProvider,
  SnapshotManifestV1,
} from '../contracts.js';
import { RateBudgetExhaustedError } from '../rateBudget.js';

export interface RepositorySnapshot {
  manifest: SnapshotManifestV1;
  /** path -> exact fetched content (bounded by the byte budget). */
  files: Map<string, string>;
  /** Actual fetched content bytes, including a rejected oversized file. */
  receivedBytes?: number;
}

export interface SnapshotOptions {
  missionId: string;
  now?: Date;
  byteBudget: number;
  maxFiles: number;
  /** Lowercased terms used to prefer relevant source files. */
  interestTerms?: string[];
}

const ALWAYS_SELECTED = [
  /^readme(\.|$)/i,
  /^license(\.|$)/i,
  /^licence(\.|$)/i,
  /^notice(\.|$)/i,
  /^contributing(\.|$)/i,
  /^(package|pyproject|cargo|go)\.mod|^(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i,
  /^dockerfile$/i,
];

const DOC_PATTERN = /^(docs?|doc)\//i;

const TEST_PATTERN = /(test|spec)/i;

export function selectSnapshotFiles(
  paths: Array<{ path: string; size: number | null }>,
  options: SnapshotOptions,
): Array<{ path: string; reason: string }> {
  const terms = options.interestTerms ?? [];
  const scored: Array<{ path: string; reason: string; priority: number }> = [];
  for (const { path, size } of paths) {
    if (size !== null && size > options.byteBudget) continue;
    const lower = path.toLowerCase();
    const base = lower.split('/').pop() ?? lower;
    if (/^(licen[cs]e|notice)(\.|$)/i.test(base) || /^(licen[cs]e|notice)s?\//i.test(lower)) {
      scored.push({ path, reason: 'license', priority: 0 });
      continue;
    }
    if (ALWAYS_SELECTED.some((re) => re.test(base) || (re.test(lower) && !lower.includes('/')))) {
      scored.push({ path, reason: 'manifest', priority: 0 });
      continue;
    }
    if (DOC_PATTERN.test(lower)) {
      scored.push({ path, reason: 'docs', priority: 2 });
      continue;
    }
    if (TEST_PATTERN.test(base)) {
      scored.push({ path, reason: 'test', priority: 3 });
      continue;
    }
    const termHits = terms.filter((term) => lower.includes(term)).length;
    if (termHits > 0) {
      scored.push({ path, reason: 'term_match', priority: 1 - Math.min(termHits, 5) * 0.01 });
      continue;
    }
  }
  return scored
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))
    .slice(0, options.maxFiles)
    .map(({ path, reason }) => ({ path, reason }));
}

/**
 * Build the snapshot. The resolved commit SHA is recorded before any
 * evidence is collected; a truncated tree is explicit in the manifest.
 */
export async function buildRepositorySnapshot(
  provider: RepositoryResearchProvider,
  identity: RepositoryIdentity,
  options: SnapshotOptions,
): Promise<RepositorySnapshot> {
  const now = (options.now ?? new Date()).toISOString();
  if (options.byteBudget <= 0) throw new RateBudgetExhaustedError('snapshot byte budget exhausted');
  const revision = await provider.resolveRevision(identity);
  const tree = await provider.getTree(revision);
  const blobs = tree.entries.filter((entry) => entry.type === 'blob');
  const selected = selectSnapshotFiles(
    blobs.map((entry) => ({ path: entry.path, size: entry.size })),
    { ...options, byteBudget: Number.MAX_SAFE_INTEGER },
  );

  const files = new Map<string, string>();
  const manifestFiles: SnapshotManifestV1['files'] = [];
  let totalBytes = 0;
  let receivedBytes = 0;
  let budgetExhausted = false;

  for (const { path, reason } of selected) {
    if (totalBytes >= options.byteBudget || manifestFiles.length >= options.maxFiles) {
      budgetExhausted = true;
      break;
    }
    const declaredSize = blobs.find(entry => entry.path === path)?.size;
    if (declaredSize !== null && declaredSize !== undefined && declaredSize > options.byteBudget - receivedBytes) {
      budgetExhausted = true;
      continue;
    }
    const file = await provider.readTextFile(revision, path);
    const sizeBytes = Buffer.byteLength(file.content, 'utf8');
    receivedBytes += sizeBytes;
    if (receivedBytes > options.byteBudget) {
      budgetExhausted = true;
      break;
    }
    files.set(path, file.content);
    totalBytes += sizeBytes;
    manifestFiles.push({
      path,
      blob_sha: file.blobSha,
      content_hash: file.contentHash,
      size_bytes: sizeBytes,
      selection_reason: reason,
      truncated: file.truncated,
    });
  }

  const manifest: SnapshotManifestV1 = {
    schema_version: 1,
    snapshot_id: `snap_${randomUUID().slice(0, 12)}`,
    mission_id: options.missionId,
    repository_id: identity.provider_repo_id,
    repository_full_name: identity.observed_full_name,
    commit_sha: revision.commitSha,
    created_at: now,
    tree_truncated: tree.truncated,
    files: manifestFiles,
    total_bytes: totalBytes,
    byte_budget: options.byteBudget,
    budget_exhausted: budgetExhausted,
  };
  return { manifest, files, receivedBytes };
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Bounded excerpt of a file between 1-based lines; null when the range is invalid. */
export function excerptLines(content: string, startLine: number, endLine: number): string | null {
  if (startLine < 1 || endLine < startLine) return null;
  const lines = content.split('\n');
  if (endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * research/analysis/repoReader.ts — quarantined repository reader
 *
 * The only analysis surface that touches remote repository content, and
 * the only channel back is a schema-validated RepoReaderReportV1 plus
 * host-created EvidenceRefs.
 *
 * Quarantine invariants:
 * - The session receives an immutable in-memory snapshot. It has no
   network handle, no shell, no filesystem access, no provider reference.
 * - The tool surface is exactly repo_tree / repo_search / repo_read /
 *   repo_symbols / repo_metadata / finish, implicitly scoped to the
 *   pinned repository + commit + mission.
 * - repo_read returns bounded views (line windows, size caps) and the
 *   host records an EvidenceRef for every returned view.
 * - finish(report) rejects any evidence_ref_id the session did not
 *   receive from the host, so a report cannot cite evidence it never
 *   observed.
 */

import type {
  EvidenceRefV1,
  RepoReaderReportV1,
  RepositoryIdentity,
  SnapshotManifestV1,
} from '../contracts.js';
import { RepoReaderReportV1Schema } from '../contracts.js';
import { excerptLines } from '../acquisition/snapshot.js';
import { sha256Hex } from '../acquisition/snapshot.js';

export const READER_TOOL_NAMES = [
  'repo_tree',
  'repo_search',
  'repo_read',
  'repo_symbols',
  'repo_metadata',
  'finish',
] as const;
export type ReaderToolName = (typeof READER_TOOL_NAMES)[number];

const MAX_READ_BYTES = 16_000;
const MAX_SEARCH_HITS = 20;

export interface RepoReadResult {
  path: string;
  /** 1-based start line of the returned window. */
  start_line: number;
  end_line: number;
  content: string;
  truncated: boolean;
  evidence_ref_id: string;
}

export interface RepoSymbolsResult {
  path: string;
  symbols: Array<{ name: string; kind: 'function' | 'class' | 'const' | 'type'; line: number }>;
}

export interface RepoTreeEntryView {
  path: string;
  size_bytes: number | null;
  selection_reason: string | null;
}

export interface RepoMetadataView {
  repository: string;
  commit_sha: string;
  tree_truncated: boolean;
  files_in_snapshot: number;
  total_bytes: number;
  license_paths: string[];
}

export interface FinishedSession {
  report: RepoReaderReportV1;
  evidenceRefs: EvidenceRefV1[];
  /** ids cited by the report but never issued by the host (removed). */
  rejectedEvidenceIds: string[];
  toolCalls: Array<{ tool: ReaderToolName; at: number }>;
}

const SYMBOL_PATTERNS: Array<{ re: RegExp; kind: RepoSymbolsResult['symbols'][number]['kind'] }> = [
  { re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const' },
  { re: /(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
];

export class RepoReaderSession {
  private readonly refsByPath = new Map<string, EvidenceRefV1[]>();
  private readonly toolCalls: Array<{ tool: ReaderToolName; at: number }> = [];
  private seq = 0;
  private finished = false;

  constructor(
    private readonly identity: RepositoryIdentity,
    private readonly manifest: SnapshotManifestV1,
    private readonly files: Map<string, string>,
    private readonly issueRef: (path: string, startLine: number, endLine: number, excerpt: string) => EvidenceRefV1,
  ) {}

  /** File list within the pinned snapshot (manifest view, not live tree). */
  repo_tree(): RepoTreeEntryView[] {
    this.record('repo_tree');
    return this.manifest.files.map((file) => ({
      path: file.path,
      size_bytes: file.size_bytes,
      selection_reason: file.selection_reason,
    }));
  }

  /** Bounded keyword search over snapshot files. Terms are data, never commands. */
  repo_search(query: string): Array<{ path: string; start_line: number; end_line: number; excerpt: string }> {
    this.record('repo_search');
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const hits: Array<{ path: string; start_line: number; end_line: number; excerpt: string }> = [];
    for (const [path, content] of this.files) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
        if (lines[i]!.toLowerCase().includes(term)) {
          const startIdx = Math.max(0, i - 1);
          const endIdx = Math.min(lines.length, i + 2);
          hits.push({
            path,
            start_line: startIdx + 1,
            end_line: endIdx,
            excerpt: lines.slice(startIdx, endIdx).join('\n'),
          });
        }
      }
      if (hits.length >= MAX_SEARCH_HITS) break;
    }
    return hits;
  }

  /** Bounded read window; the host records the evidence ref for exactly these bytes. */
  repo_read(path: string, startLine = 1, endLine = 400): RepoReadResult | null {
    this.record('repo_read');
    const content = this.files.get(path);
    if (content === undefined) return null;
    const totalLines = content.split('\n').length;
    const clampedEnd = Math.min(endLine, totalLines, startLine + 499);
    const excerpt = excerptLines(content, startLine, clampedEnd);
    if (excerpt === null) return null;
    const actualEnd = startLine + excerpt.split('\n').length - 1;
    const truncated = Buffer.byteLength(excerpt, 'utf8') >= MAX_READ_BYTES || actualEnd < endLine;
    const ref = this.issueRef(path, startLine, actualEnd, excerpt);
    this.pushRef(path, ref);
    return {
      path,
      start_line: startLine,
      end_line: actualEnd,
      content: excerpt.length > MAX_READ_BYTES ? excerpt.slice(0, MAX_READ_BYTES) : excerpt,
      truncated,
      evidence_ref_id: ref.evidence_id,
    };
  }

  /** Line-anchored symbol heuristic over one snapshot file. */
  repo_symbols(path: string): RepoSymbolsResult | null {
    this.record('repo_symbols');
    const content = this.files.get(path);
    if (content === undefined) return null;
    const symbols: RepoSymbolsResult['symbols'] = [];
    content.split('\n').forEach((line, idx) => {
      for (const { re, kind } of SYMBOL_PATTERNS) {
        const match = line.match(re);
        if (match?.[1]) {
          symbols.push({ name: match[1], kind, line: idx + 1 });
          break;
        }
      }
    });
    return { path, symbols };
  }

  repo_metadata(): RepoMetadataView {
    this.record('repo_metadata');
    return {
      repository: this.manifest.repository_full_name,
      commit_sha: this.manifest.commit_sha,
      tree_truncated: this.manifest.tree_truncated,
      files_in_snapshot: this.manifest.files.length,
      total_bytes: this.manifest.total_bytes,
      license_paths: this.manifest.files.filter((f) => f.selection_reason === 'license').map((f) => f.path),
    };
  }

  /**
   * Terminate the session with the structured report. The report is
   * strict-validated; evidence ids the host never issued are stripped
   * and reported. The session cannot be reused after finish().
   */
  finish(report: unknown): FinishedSession {
    this.record('finish');
    if (this.finished) throw new Error('reader session already finished');
    this.finished = true;
    const parsed = RepoReaderReportV1Schema.parse({
      ...(report as Record<string, unknown>),
      repository: this.manifest.repository_full_name,
      commit_sha: this.manifest.commit_sha,
    });
    const known = new Set<string>();
    for (const refs of this.refsByPath.values()) {
      for (const ref of refs) known.add(ref.evidence_id);
    }
    const rejectedEvidenceIds: string[] = [];
    const observations = parsed.observations
      .map((observation) => {
        const accepted = observation.evidence_ref_ids.filter((id) => {
          if (known.has(id)) return true;
          rejectedEvidenceIds.push(id);
          return false;
        });
        return { ...observation, evidence_ref_ids: [...new Set(accepted)] };
      })
      .filter((observation) => observation.evidence_ref_ids.length > 0 || observation.kind !== 'source_observed');
    const checked: RepoReaderReportV1 = { ...parsed, observations };
    return {
      report: checked,
      evidenceRefs: [...this.refsByPath.values()].flat(),
      rejectedEvidenceIds,
      toolCalls: this.toolCalls,
    };
  }

  private pushRef(path: string, ref: EvidenceRefV1): void {
    const existing = this.refsByPath.get(path) ?? [];
    existing.push(ref);
    this.refsByPath.set(path, existing);
  }

  private record(tool: ReaderToolName): void {
    this.toolCalls.push({ tool, at: this.seq++ });
  }
}

/** Host-side ref issuer bound to one snapshot; used by the session constructor. */
export function makeRefIssuer(
  manifest: SnapshotManifestV1,
  files: Map<string, string>,
  counters: { n: number },
): (path: string, startLine: number, endLine: number, excerpt: string) => EvidenceRefV1 {
  return (path, startLine, endLine, excerpt) => {
    if (!files.has(path)) throw new Error(`ref issuer: path not in snapshot: ${path}`);
    counters.n += 1;
    return {
      schema_version: 1,
      evidence_id: `ev_${manifest.repository_id}_${String(counters.n).padStart(4, '0')}`,
      repository_id: manifest.repository_id,
      repository_full_name: manifest.repository_full_name,
      commit_sha: manifest.commit_sha,
      path,
      start_line: startLine,
      end_line: endLine,
      content_hash: sha256Hex(excerpt),
      acquisition_method: 'github_contents',
      observed_at: manifest.created_at,
    };
  };
}

export function openReaderSession(identity: RepositoryIdentity, snapshot: {
  manifest: SnapshotManifestV1;
  files: Map<string, string>;
}): RepoReaderSession {
  const counters = { n: 0 };
  return new RepoReaderSession(identity, snapshot.manifest, snapshot.files, makeRefIssuer(snapshot.manifest, snapshot.files, counters));
}

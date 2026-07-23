/**
 * CodeGraphBackend — typed interface over the codebase-memory-mcp MCP server.
 *
 * Wraps the MCP binary's tools behind clean TypeScript methods with camelCase
 * parameters and structured return types. Each method spawns/kills the MCP
 * binary per call (matching Babel's existing per-request MCP transport model).
 *
 * The knowledge graph is persisted in SQLite at ~/.cache/codebase-memory-mcp/
 * so cold-starting the binary per call is sub-second once indexed.
 *
 * @module codeGraphBackend
 */

import { handleMcpToolCall } from '../tools/mcpTransport.js';

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_NAME = 'codebase-memory';

// ── Error Types ────────────────────────────────────────────────────────────

export class CodeGraphNotIndexedError extends Error {
  constructor() {
    super('Knowledge graph has not been indexed yet. Run indexing first.');
    this.name = 'CodeGraphNotIndexedError';
  }
}

export class CodeGraphBackendError extends Error {
  constructor(
    message: string,
    public readonly tool: string,
  ) {
    super(message);
    this.name = 'CodeGraphBackendError';
  }
}

// ── Public Types ───────────────────────────────────────────────────────────

export interface IndexStatus {
  status: 'empty' | 'ready' | 'stale';
  nodeCount: number | undefined;
  edgeCount: number | undefined;
  lastIndexedTimestamp: number | undefined;
}

export type TraceDirection = 'inbound' | 'outbound' | 'both';

export interface CallPathEdge {
  from: string;
  to: string;
  fromFile: string;
  fromLine: number;
  toFile: string;
  toLine: number;
  relationship: string;
}

export interface TracePathResult {
  symbol: string;
  direction: TraceDirection;
  edges: CallPathEdge[];
}

export interface SearchGraphMatch {
  symbol: string;
  kind: string;
  file: string;
  line: number;
  signature: string | undefined;
}

export interface SearchGraphResult {
  matches: SearchGraphMatch[];
  total: number;
}

export interface ImpactHop {
  depth: number;
  symbol: string;
  file: string;
  line: number;
  risk: 'high' | 'medium' | 'low';
  callers: string[];
  callees: string[];
}

export interface ImpactResult {
  changedSymbols: string[];
  hops: ImpactHop[];
  summary: { high: number; medium: number; low: number };
}

export interface ArchitectureStats {
  languages: Record<string, number>;
  packages: Array<{ name: string; symbolCount: number }>;
  hotspots: Array<{
    symbol: string;
    complexity: number;
    file: string;
    line: number;
  }>;
  totalSymbols: number;
  totalFiles: number;
}

// ── Backend Class ──────────────────────────────────────────────────────────

export class CodeGraphBackend {
  private readonly serverName: string;
  private readonly handleCall: typeof handleMcpToolCall;

  constructor(
    serverName: string = SERVER_NAME,
    handleCall: typeof handleMcpToolCall = handleMcpToolCall,
  ) {
    this.serverName = serverName;
    this.handleCall = handleCall;
  }

  // ── Index Status ──────────────────────────────────────────────────────

  /**
   * Check whether the knowledge graph has been indexed and is ready for queries.
   * Returns { status: 'empty' } when no index exists (not an error).
   */
  async getIndexStatus(): Promise<IndexStatus> {
    const result = await this.handleCall(this.serverName, 'index_status', {});

    if (result.exit_code !== 0) {
      // Distinguish infrastructure failures from "not indexed yet":
      // when stderr carries a diagnostic, surface it via a thrown error so the
      // caller can report it; otherwise return 'empty' (binary not installed).
      if (result.stderr) {
        throw new CodeGraphBackendError(
          result.stderr,
          'index_status',
        );
      }
      return {
        status: 'empty',
        nodeCount: undefined,
        edgeCount: undefined,
        lastIndexedTimestamp: undefined,
      };
    }

    try {
      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      return {
        status: (data['status'] as IndexStatus['status']) ?? 'empty',
        nodeCount:
          typeof data['node_count'] === 'number'
            ? data['node_count']
            : undefined,
        edgeCount:
          typeof data['edge_count'] === 'number'
            ? data['edge_count']
            : undefined,
        lastIndexedTimestamp:
          typeof data['last_indexed_timestamp'] === 'number'
            ? data['last_indexed_timestamp']
            : undefined,
      };
    } catch {
      throw new CodeGraphBackendError(
        'Failed to parse index_status response',
        'index_status',
      );
    }
  }

  // ── Trace Path ────────────────────────────────────────────────────────

  /**
   * Trace call paths for a symbol — shows callers (inbound), callees (outbound),
   * or both directions through the call graph.
   */
  async tracePath(
    symbol: string,
    direction: TraceDirection = 'both',
    maxDepth?: number,
  ): Promise<TracePathResult> {
    const params: Record<string, unknown> = {
      function_name: symbol,
      direction,
    };
    if (maxDepth !== undefined) params['depth'] = maxDepth;

    const result = await this.handleCall(this.serverName, 'trace_path', params);

    if (result.exit_code !== 0) {
      throw new CodeGraphBackendError(result.stderr || 'trace_path failed', 'trace_path');
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const rawEdges = Array.isArray(parsed['edges']) ? parsed['edges'] : [];
      const edges: CallPathEdge[] = rawEdges.map((e: Record<string, unknown>) => ({
        from: String(e['from'] ?? ''),
        to: String(e['to'] ?? ''),
        fromFile: String(e['from_file'] ?? e['fromFile'] ?? ''),
        fromLine: Number(e['from_line'] ?? e['fromLine'] ?? 0),
        toFile: String(e['to_file'] ?? e['toFile'] ?? ''),
        toLine: Number(e['to_line'] ?? e['toLine'] ?? 0),
        relationship: String(e['relationship'] ?? e['call_type'] ?? e['callType'] ?? ''),
      }));

      return {
        symbol,
        direction,
        edges,
      };
    } catch (err) {
      throw new CodeGraphBackendError(
        `Failed to parse trace_path response: ${err instanceof Error ? err.message : String(err)}`,
        'trace_path',
      );
    }
  }

  // ── Search Graph ──────────────────────────────────────────────────────

  /**
   * Search the knowledge graph for code symbols matching a query.
   */
  async searchGraph(
    query: string,
    kind?: string,
    limit?: number,
  ): Promise<SearchGraphResult> {
    const params: Record<string, unknown> = {
      query,
    };
    if (kind !== undefined) params['kind'] = kind;
    if (limit !== undefined) params['limit'] = limit;

    const result = await this.handleCall(this.serverName, 'search_graph', params);

    if (result.exit_code !== 0) {
      throw new CodeGraphBackendError(result.stderr || 'search_graph failed', 'search_graph');
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const rawMatches = Array.isArray(parsed['matches']) ? parsed['matches'] : [];
      const matches: SearchGraphMatch[] = rawMatches.map((m: Record<string, unknown>) => ({
        symbol: String(m['symbol'] ?? m['name'] ?? ''),
        kind: String(m['kind'] ?? m['type'] ?? ''),
        file: String(m['file'] ?? ''),
        line: Number(m['line'] ?? 0),
        signature: typeof m['signature'] === 'string' ? m['signature'] : undefined,
      }));

      return {
        matches,
        total: typeof parsed['total'] === 'number' ? parsed['total'] : matches.length,
      };
    } catch (err) {
      throw new CodeGraphBackendError(
        `Failed to parse search_graph response: ${err instanceof Error ? err.message : String(err)}`,
        'search_graph',
      );
    }
  }

  // ── Impact Analysis ───────────────────────────────────────────────────

  /**
   * Analyze the impact of changes to files or symbols with risk classification.
   * Returns hops grouped by risk level (HIGH / MEDIUM / LOW).
   */
  async impactAnalysis(
    files?: string[],
    symbol?: string,
    depth?: number,
  ): Promise<ImpactResult> {
    const params: Record<string, unknown> = {};
    if (files !== undefined && files.length > 0) params['files'] = files;
    if (symbol !== undefined) params['symbol'] = symbol;
    if (depth !== undefined) params['depth'] = depth;

    const result = await this.handleCall(this.serverName, 'detect_changes', params);

    if (result.exit_code !== 0) {
      throw new CodeGraphBackendError(
        result.stderr || 'detect_changes failed',
        'detect_changes',
      );
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const rawHops = Array.isArray(parsed['hops']) ? parsed['hops'] : [];
      const changedSymbols: string[] = Array.isArray(parsed['changed_symbols'])
        ? parsed['changed_symbols'].map(String)
        : [];

      const hops: ImpactHop[] = rawHops.map((h: Record<string, unknown>) => ({
        depth: Number(h['depth'] ?? h['hop'] ?? 0),
        symbol: String(h['symbol'] ?? ''),
        file: String(h['file'] ?? ''),
        line: Number(h['line'] ?? 0),
        risk: normalizeRisk(String(h['risk'] ?? h['risk_level'] ?? 'low')),
        callers: Array.isArray(h['callers']) ? h['callers'].map(String) : [],
        callees: Array.isArray(h['callees']) ? h['callees'].map(String) : [],
      }));

      const summary = {
        high: hops.filter((h) => h.risk === 'high').length,
        medium: hops.filter((h) => h.risk === 'medium').length,
        low: hops.filter((h) => h.risk === 'low').length,
      };

      return { changedSymbols, hops, summary };
    } catch (err) {
      throw new CodeGraphBackendError(
        `Failed to parse detect_changes response: ${err instanceof Error ? err.message : String(err)}`,
        'detect_changes',
      );
    }
  }

  // ── Architecture ──────────────────────────────────────────────────────

  /**
   * Get a high-level architecture overview: language breakdown, hotspots, packages.
   */
  async getArchitecture(
    scope?: string,
    detail?: 'summary' | 'full',
  ): Promise<ArchitectureStats> {
    const params: Record<string, unknown> = {};
    if (scope !== undefined) params['scope'] = scope;
    if (detail !== undefined) params['detail'] = detail;

    const result = await this.handleCall(this.serverName, 'get_architecture', params);

    if (result.exit_code !== 0) {
      throw new CodeGraphBackendError(
        result.stderr || 'get_architecture failed',
        'get_architecture',
      );
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const languages: Record<string, number> = {};
      const rawLanguages = parsed['languages'];
      if (typeof rawLanguages === 'object' && rawLanguages !== null) {
        for (const [lang, count] of Object.entries(rawLanguages)) {
          languages[lang] = Number(count);
        }
      }

      const rawPackages = Array.isArray(parsed['packages']) ? parsed['packages'] : [];
      const packages = rawPackages.map((p: Record<string, unknown>) => ({
        name: String(p['name'] ?? ''),
        symbolCount: Number(p['symbol_count'] ?? p['symbolCount'] ?? 0),
      }));

      const rawHotspots = Array.isArray(parsed['hotspots']) ? parsed['hotspots'] : [];
      const hotspots = rawHotspots.map((h: Record<string, unknown>) => ({
        symbol: String(h['symbol'] ?? ''),
        complexity: Number(h['complexity'] ?? 0),
        file: String(h['file'] ?? ''),
        line: Number(h['line'] ?? 0),
      }));

      return {
        languages,
        packages,
        hotspots,
        totalSymbols: Number(parsed['total_symbols'] ?? parsed['totalSymbols'] ?? 0),
        totalFiles: Number(parsed['total_files'] ?? parsed['totalFiles'] ?? 0),
      };
    } catch (err) {
      throw new CodeGraphBackendError(
        `Failed to parse get_architecture response: ${err instanceof Error ? err.message : String(err)}`,
        'get_architecture',
      );
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeRisk(raw: string): 'high' | 'medium' | 'low' {
  const lower = raw.toLowerCase().trim();
  if (lower === 'high' || lower === 'critical') return 'high';
  if (lower === 'medium' || lower === 'moderate') return 'medium';
  return 'low';
}

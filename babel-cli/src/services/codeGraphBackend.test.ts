/**
 * Tests for CodeGraphBackend — covers all five kg_* tool backend methods.
 *
 * Uses constructor dependency injection to supply a fake handleMcpToolCall,
 * exercising JSON parsing, field mapping, error classification, and the C9
 * getIndexStatus empty-vs-throw distinction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodeGraphBackend,
  CodeGraphBackendError,
  type IndexStatus,
  type TracePathResult,
  type SearchGraphResult,
  type ImpactResult,
  type ArchitectureStats,
} from './codeGraphBackend.js';
import type { ToolResult } from '../sandbox.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function toolResult(
  exitCode: number,
  stdout: string,
  stderr = '',
): ToolResult {
  return { exit_code: exitCode, stdout, stderr };
}

function jsonResult(data: Record<string, unknown>): ToolResult {
  return toolResult(0, JSON.stringify(data));
}

function errorResult(stderr: string): ToolResult {
  return { exit_code: 1, stdout: '', stderr };
}

/**
 * Create a backend with an injected fake handleMcpToolCall.  The `stub`
 * function is called in place of the real MCP transport.  Callers reassign
 * the closure variable between subtests.
 */
function createBackend(
  getResponse: () => ToolResult,
): CodeGraphBackend {
  return new CodeGraphBackend('test-server', async () => getResponse());
}

// ── getIndexStatus (C9 critical) ────────────────────────────────────────────

test('getIndexStatus', async (t) => {
  let response = (): ToolResult => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('success returns ready status with counts', async () => {
    response = () =>
      jsonResult({
        status: 'ready',
        node_count: 42,
        edge_count: 7,
        last_indexed_timestamp: 1718400000,
      });

    const result: IndexStatus = await backend.getIndexStatus();
    assert.equal(result.status, 'ready');
    assert.equal(result.nodeCount, 42);
    assert.equal(result.edgeCount, 7);
    assert.equal(result.lastIndexedTimestamp, 1718400000);
  });

  await t.test('success returns stale status', async () => {
    response = () => jsonResult({ status: 'stale' });

    const result = await backend.getIndexStatus();
    assert.equal(result.status, 'stale');
    assert.equal(result.nodeCount, undefined);
    assert.equal(result.edgeCount, undefined);
  });

  // C9 — critical: empty stderr returns 'empty', does NOT throw
  await t.test('C9: non-zero exit with empty stderr returns empty status', async () => {
    response = () => toolResult(1, '', '');

    const result = await backend.getIndexStatus();
    assert.equal(result.status, 'empty');
    assert.equal(result.nodeCount, undefined);
    assert.equal(result.edgeCount, undefined);
    assert.equal(result.lastIndexedTimestamp, undefined);
  });

  // C9 — critical: non-empty stderr throws
  await t.test('C9: non-zero exit with non-empty stderr throws CodeGraphBackendError', async () => {
    response = () => errorResult('binary not found');

    await assert.rejects(
      () => backend.getIndexStatus(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('binary not found'),
        );
        assert.equal((err as CodeGraphBackendError).tool, 'index_status');
        return true;
      },
    );
  });

  await t.test('malformed JSON in stdout throws', async () => {
    response = () => toolResult(0, 'not valid json');

    await assert.rejects(
      () => backend.getIndexStatus(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('index_status'),
        );
        return true;
      },
    );
  });

  await t.test('handles missing fields — defaults status to empty', async () => {
    response = () => jsonResult({});

    const result = await backend.getIndexStatus();
    assert.equal(result.status, 'empty');
    assert.equal(result.nodeCount, undefined);
  });
});

// ── tracePath ────────────────────────────────────────────────────────────────

test('tracePath', async (t) => {
  let response = (): ToolResult => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('success returns parsed edges', async () => {
    response = () =>
      jsonResult({
        edges: [
          {
            from: 'callerFn',
            to: 'calleeFn',
            from_file: 'src/caller.ts',
            from_line: 10,
            to_file: 'src/callee.ts',
            to_line: 42,
            relationship: 'calls',
          },
        ],
      });

    const result: TracePathResult = await backend.tracePath('mySymbol');
    assert.equal(result.symbol, 'mySymbol');
    assert.equal(result.direction, 'both');
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0]!.from, 'callerFn');
    assert.equal(result.edges[0]!.to, 'calleeFn');
    assert.equal(result.edges[0]!.fromFile, 'src/caller.ts');
    assert.equal(result.edges[0]!.fromLine, 10);
  });

  await t.test('handles snake_case field aliases', async () => {
    response = () =>
      jsonResult({
        edges: [
          {
            from: 'A',
            to: 'B',
            from_file: 'a.ts',
            from_line: 1,
            to_file: 'b.ts',
            to_line: 2,
            relationship: 'imports',
          },
        ],
      });

    const result = await backend.tracePath('sym');
    assert.equal(result.edges[0]!.fromFile, 'a.ts');
    assert.equal(result.edges[0]!.relationship, 'imports');
  });

  await t.test('handles camelCase field aliases', async () => {
    response = () =>
      jsonResult({
        edges: [
          {
            from: 'A',
            to: 'B',
            fromFile: 'camelFrom.ts',
            fromLine: 5,
            toFile: 'camelTo.ts',
            toLine: 8,
            callType: 'references',
          },
        ],
      });

    const result = await backend.tracePath('sym');
    assert.equal(result.edges[0]!.fromFile, 'camelFrom.ts');
    assert.equal(result.edges[0]!.relationship, 'references');
  });

  await t.test('non-zero exit with stderr throws CodeGraphBackendError', async () => {
    response = () => errorResult('Tool error');

    await assert.rejects(
      () => backend.tracePath('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('Tool error'),
        );
        return true;
      },
    );
  });

  await t.test('non-zero exit without stderr uses default message', async () => {
    response = () => toolResult(1, '', '');

    await assert.rejects(
      () => backend.tracePath('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('trace_path failed'),
        );
        return true;
      },
    );
  });

  await t.test('malformed JSON throws with parse error', async () => {
    response = () => toolResult(0, 'broken json {{{');

    await assert.rejects(
      () => backend.tracePath('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes(
            'Failed to parse trace_path',
          ),
        );
        return true;
      },
    );
  });
});

// ── searchGraph ──────────────────────────────────────────────────────────────

test('searchGraph', async (t) => {
  let response = (): ToolResult => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('success returns matches with total', async () => {
    response = () =>
      jsonResult({
        matches: [
          { symbol: 'myFunc', kind: 'function', file: 'src/lib.ts', line: 10 },
        ],
        total: 1,
      });

    const result: SearchGraphResult = await backend.searchGraph('myFunc');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.symbol, 'myFunc');
    assert.equal(result.total, 1);
  });

  await t.test('handles match without signature field', async () => {
    response = () =>
      jsonResult({
        matches: [{ symbol: 'fn', kind: 'function', file: 'f.ts', line: 1 }],
      });

    const result = await backend.searchGraph('fn');
    assert.equal(result.matches[0]!.signature, undefined);
  });

  await t.test('infers total from matches length when absent', async () => {
    response = () =>
      jsonResult({
        matches: [
          { symbol: 'a', kind: 'class', file: 'a.ts', line: 1 },
          { symbol: 'b', kind: 'class', file: 'b.ts', line: 1 },
        ],
      });

    const result = await backend.searchGraph('query');
    assert.equal(result.total, 2);
  });

  await t.test('non-zero exit throws', async () => {
    response = () => errorResult('Search failed');

    await assert.rejects(
      () => backend.searchGraph('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('Search failed'),
        );
        return true;
      },
    );
  });

  await t.test('malformed JSON throws', async () => {
    response = () => toolResult(0, 'broken');

    await assert.rejects(
      () => backend.searchGraph('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('search_graph'),
        );
        return true;
      },
    );
  });
});

// ── impactAnalysis ───────────────────────────────────────────────────────────

test('impactAnalysis', async (t) => {
  let response = (): ToolResult => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('success returns hops and summary', async () => {
    response = () =>
      jsonResult({
        changed_symbols: ['modifiedFn'],
        hops: [
          {
            depth: 1,
            symbol: 'caller1',
            file: 'a.ts',
            line: 5,
            risk: 'high',
            callers: [],
            callees: ['modifiedFn'],
          },
          {
            depth: 2,
            symbol: 'caller2',
            file: 'b.ts',
            line: 12,
            risk: 'medium',
            callers: ['caller1'],
            callees: [],
          },
          {
            depth: 1,
            symbol: 'caller3',
            file: 'c.ts',
            line: 3,
            risk: 'low',
            callers: [],
            callees: [],
          },
        ],
      });

    const result: ImpactResult = await backend.impactAnalysis(
      undefined,
      undefined,
      2,
    );
    assert.equal(result.changedSymbols.length, 1);
    assert.equal(result.hops.length, 3);
    assert.deepEqual(result.summary, { high: 1, medium: 1, low: 1 });
  });

  await t.test('normalizes risk values', async () => {
    response = () =>
      jsonResult({
        hops: [
          { depth: 1, symbol: 'a', file: 'a.ts', line: 1, risk: 'critical', callers: [], callees: [] },
          { depth: 1, symbol: 'b', file: 'b.ts', line: 1, risk: 'moderate', callers: [], callees: [] },
          { depth: 1, symbol: 'c', file: 'c.ts', line: 1, risk: 'low', callers: [], callees: [] },
        ],
      });

    const result = await backend.impactAnalysis(undefined, undefined, 1);
    assert.equal(result.hops[0]!.risk, 'high');
    assert.equal(result.hops[1]!.risk, 'medium');
    assert.equal(result.hops[2]!.risk, 'low');
  });

  await t.test('handles empty hops and changed_symbols', async () => {
    response = () => jsonResult({ changed_symbols: [], hops: [] });

    const result = await backend.impactAnalysis([], undefined, 1);
    assert.equal(result.changedSymbols.length, 0);
    assert.equal(result.hops.length, 0);
    assert.deepEqual(result.summary, { high: 0, medium: 0, low: 0 });
  });

  await t.test('non-zero exit throws', async () => {
    response = () => errorResult('detect_changes crashed');

    await assert.rejects(
      () => backend.impactAnalysis(['someFile.ts'], undefined, 2),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        return true;
      },
    );
  });

  await t.test('malformed JSON throws', async () => {
    response = () => toolResult(0, 'bad');

    await assert.rejects(
      () => backend.impactAnalysis(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('detect_changes'),
        );
        return true;
      },
    );
  });
});

// ── getArchitecture ──────────────────────────────────────────────────────────

test('getArchitecture', async (t) => {
  let response = (): ToolResult => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('success returns full architecture stats', async () => {
    response = () =>
      jsonResult({
        languages: { TypeScript: 150, Rust: 3 },
        packages: [{ name: 'babel-cli', symbol_count: 200 }],
        hotspots: [
          {
            symbol: 'pipeline',
            complexity: 85,
            file: 'src/pipeline.ts',
            line: 1,
          },
        ],
        total_symbols: 5000,
        total_files: 300,
      });

    const result: ArchitectureStats = await backend.getArchitecture();
    assert.deepEqual(result.languages, { TypeScript: 150, Rust: 3 });
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0]!.name, 'babel-cli');
    assert.equal(result.hotspots.length, 1);
    assert.equal(result.hotspots[0]!.complexity, 85);
    assert.equal(result.totalSymbols, 5000);
    assert.equal(result.totalFiles, 300);
  });

  await t.test('handles partial fields gracefully', async () => {
    response = () => jsonResult({});

    const result = await backend.getArchitecture();
    assert.deepEqual(result.languages, {});
    assert.equal(result.packages.length, 0);
    assert.equal(result.hotspots.length, 0);
    assert.equal(result.totalSymbols, 0);
    assert.equal(result.totalFiles, 0);
  });

  await t.test('non-zero exit throws', async () => {
    response = () => errorResult('architecture tool failed');

    await assert.rejects(
      () => backend.getArchitecture(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        return true;
      },
    );
  });

  await t.test('malformed JSON throws', async () => {
    response = () => toolResult(0, 'bad');

    await assert.rejects(
      () => backend.getArchitecture(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes('get_architecture'),
        );
        return true;
      },
    );
  });
});

// ── MCP envelope failure across methods ──────────────────────────────────────

test('MCP parse failure surfaces as CodeGraphBackendError', async (t) => {
  let response = (): ToolResult => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('tracePath with MCP parse failure', async () => {
    response = () => toolResult(1, '', 'MCP response parsing failed');

    await assert.rejects(
      () => backend.tracePath('sym'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok(
          (err as CodeGraphBackendError).message.includes(
            'MCP response parsing failed',
          ),
        );
        return true;
      },
    );
  });
});

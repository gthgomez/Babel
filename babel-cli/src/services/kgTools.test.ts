/**
 * Tests for the five kg_* knowledge-graph tools.
 *
 * Mocks at the handleMcpToolCall boundary via CodeGraphBackend constructor DI,
 * covering success paths, error paths (non-zero exit, timeout/rejection,
 * malformed JSON), and the C9 empty-vs-throw distinction in getIndexStatus.
 *
 * These complement codeGraphBackend.test.ts, which focuses on parsing and
 * field-mapping.  This file focuses on tool-level behavior: the ToolResult
 * shape each tool produces and the error-wrapping contract each handler
 * relies on.
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

/** Simulate a transport-level rejection (timeout, network error, etc.). */
function rejectionResult(message: string): Promise<ToolResult> {
  return Promise.reject(new Error(message));
}

/**
 * Create a backend with an injected fake handleMcpToolCall.
 * The caller reassigns the closure variable between subtests.
 */
function createBackend(
  getResponse: () => ToolResult | Promise<ToolResult>,
): CodeGraphBackend {
  return new CodeGraphBackend('test-server', async () => getResponse());
}

// ── kg_trace_path ────────────────────────────────────────────────────────────

test('kg_trace_path', async (t) => {
  let response = (): ToolResult | Promise<ToolResult> => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('returns edges on success', async () => {
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
            call_type: 'calls',
          },
        ],
      });

    const result: TracePathResult = await backend.tracePath('myFunc');
    assert.equal(result.symbol, 'myFunc');
    assert.equal(result.direction, 'both');
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0]!.from, 'callerFn');
    assert.equal(result.edges[0]!.to, 'calleeFn');
  });

  await t.test('returns empty edges when no call path exists', async () => {
    response = () => jsonResult({ edges: [] });

    const result = await backend.tracePath('orphanFunc');
    assert.equal(result.edges.length, 0);
  });

  await t.test('handles direction and maxDepth parameters', async () => {
    response = () =>
      jsonResult({
        edges: [
          {
            from: 'a',
            to: 'b',
            from_file: 'a.ts',
            from_line: 1,
            to_file: 'b.ts',
            to_line: 2,
            call_type: 'calls',
          },
        ],
      });

    const result = await backend.tracePath('a', 'inbound', 3);
    assert.equal(result.direction, 'inbound');
  });

  await t.test('non-zero exit with stderr throws CodeGraphBackendError', async () => {
    response = () => errorResult('Symbol not found in graph');

    await assert.rejects(
      () => backend.tracePath('nonexistent'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('Symbol not found'));
        assert.equal((err as CodeGraphBackendError).tool, 'trace_path');
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
        assert.ok((err as CodeGraphBackendError).message.includes('trace_path failed'));
        return true;
      },
    );
  });

  await t.test('rejected promise (timeout) propagates rejection message', async () => {
    response = () => rejectionResult('MCP transport timed out');

    await assert.rejects(
      () => backend.tracePath('slowFunc'),
      (err: unknown) => {
        // Rejections from handleMcpToolCall are NOT wrapped in
        // CodeGraphBackendError — they propagate as-is to the caller
        // (the tool handler in localTools.ts catches them).
        assert.ok((err as Error).message.includes('MCP transport timed out'));
        return true;
      },
    );
  });

  await t.test('malformed JSON in stdout surfaces as error', async () => {
    response = () => toolResult(0, '{{{ broken json');

    await assert.rejects(
      () => backend.tracePath('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('Failed to parse trace_path'));
        return true;
      },
    );
  });
});

// ── kg_search_graph ──────────────────────────────────────────────────────────

test('kg_search_graph', async (t) => {
  let response = (): ToolResult | Promise<ToolResult> => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('returns matches on success', async () => {
    response = () =>
      jsonResult({
        matches: [
          { symbol: 'myFunc', kind: 'function', file: 'src/lib.ts', line: 10, signature: '(x: number) => string' },
          { symbol: 'MyClass', kind: 'class', file: 'src/lib.ts', line: 42 },
        ],
        total: 2,
      });

    const result: SearchGraphResult = await backend.searchGraph('myFunc');
    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0]!.symbol, 'myFunc');
    assert.equal(result.matches[0]!.signature, '(x: number) => string');
    assert.equal(result.total, 2);
  });

  await t.test('returns empty matches when nothing is found', async () => {
    response = () => jsonResult({ matches: [], total: 0 });

    const result = await backend.searchGraph('zzz_nonexistent');
    assert.equal(result.matches.length, 0);
    assert.equal(result.total, 0);
  });

  await t.test('infers total from matches length when absent', async () => {
    response = () =>
      jsonResult({
        matches: [
          { symbol: 'a', kind: 'function', file: 'a.ts', line: 1 },
          { symbol: 'b', kind: 'function', file: 'a.ts', line: 2 },
        ],
      });

    const result = await backend.searchGraph('q');
    assert.equal(result.total, 2);
  });

  await t.test('non-zero exit throws CodeGraphBackendError', async () => {
    response = () => errorResult('Search failed: graph not ready');

    await assert.rejects(
      () => backend.searchGraph('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('Search failed'));
        assert.equal((err as CodeGraphBackendError).tool, 'search_graph');
        return true;
      },
    );
  });

  await t.test('rejected promise propagates rejection message', async () => {
    response = () => rejectionResult('connection refused');

    await assert.rejects(
      () => backend.searchGraph('x'),
      (err: unknown) => {
        assert.ok((err as Error).message.includes('connection refused'));
        return true;
      },
    );
  });

  await t.test('malformed JSON surfaces as error', async () => {
    response = () => toolResult(0, 'not even close to json');

    await assert.rejects(
      () => backend.searchGraph('x'),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('search_graph'));
        return true;
      },
    );
  });
});

// ── kg_impact_analysis ───────────────────────────────────────────────────────

test('kg_impact_analysis', async (t) => {
  let response = (): ToolResult | Promise<ToolResult> => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('returns hops and summary on success', async () => {
    response = () =>
      jsonResult({
        changed_symbols: ['editedFn'],
        hops: [
          {
            depth: 1,
            symbol: 'immediateCaller',
            file: 'a.ts',
            line: 10,
            risk: 'high',
            callers: [],
            callees: ['editedFn'],
          },
          {
            depth: 2,
            symbol: 'transitiveCaller',
            file: 'b.ts',
            line: 25,
            risk: 'medium',
            callers: ['immediateCaller'],
            callees: [],
          },
        ],
      });

    const result: ImpactResult = await backend.impactAnalysis(
      ['src/edited.ts'],
      undefined,
      3,
    );
    assert.equal(result.changedSymbols.length, 1);
    assert.equal(result.changedSymbols[0], 'editedFn');
    assert.equal(result.hops.length, 2);
    assert.equal(result.hops[0]!.risk, 'high');
    assert.equal(result.hops[1]!.risk, 'medium');
    assert.deepEqual(result.summary, { high: 1, medium: 1, low: 0 });
  });

  await t.test('returns empty hops when no impact detected', async () => {
    response = () => jsonResult({ changed_symbols: [], hops: [] });

    const result = await backend.impactAnalysis(['src/unused.ts']);
    assert.equal(result.changedSymbols.length, 0);
    assert.equal(result.hops.length, 0);
    assert.deepEqual(result.summary, { high: 0, medium: 0, low: 0 });
  });

  await t.test('normalizes risk variants', async () => {
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

  await t.test('non-zero exit throws CodeGraphBackendError', async () => {
    response = () => errorResult('detect_changes: index not built');

    await assert.rejects(
      () => backend.impactAnalysis(['f.ts']),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('detect_changes'));
        return true;
      },
    );
  });

  await t.test('rejected promise propagates rejection message', async () => {
    response = () => rejectionResult('MCP server not reachable');

    await assert.rejects(
      () => backend.impactAnalysis(['f.ts']),
      (err: unknown) => {
        assert.ok((err as Error).message.includes('MCP server not reachable'));
        return true;
      },
    );
  });

  await t.test('malformed JSON surfaces as error', async () => {
    response = () => toolResult(0, '{{{');

    await assert.rejects(
      () => backend.impactAnalysis(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('detect_changes'));
        return true;
      },
    );
  });
});

// ── kg_architecture ──────────────────────────────────────────────────────────

test('kg_architecture', async (t) => {
  let response = (): ToolResult | Promise<ToolResult> => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('returns full architecture stats on success', async () => {
    response = () =>
      jsonResult({
        languages: { TypeScript: 150, Rust: 3, Python: 20 },
        packages: [
          { name: 'babel-cli', symbol_count: 200 },
          { name: 'prompts', symbol_count: 45 },
        ],
        hotspots: [
          { symbol: 'pipeline', complexity: 85, file: 'src/pipeline.ts', line: 1 },
          { symbol: 'compiler', complexity: 72, file: 'src/compiler.ts', line: 50 },
        ],
        total_symbols: 5000,
        total_files: 300,
      });

    const result: ArchitectureStats = await backend.getArchitecture('full');
    assert.deepEqual(result.languages, { TypeScript: 150, Rust: 3, Python: 20 });
    assert.equal(result.packages.length, 2);
    assert.equal(result.packages[0]!.name, 'babel-cli');
    assert.equal(result.hotspots.length, 2);
    assert.equal(result.hotspots[0]!.symbol, 'pipeline');
    assert.equal(result.totalSymbols, 5000);
    assert.equal(result.totalFiles, 300);
  });

  await t.test('handles scope and detail parameters', async () => {
    response = () => jsonResult({
      languages: {},
      packages: [],
      hotspots: [],
      total_symbols: 0,
      total_files: 0,
    });

    const summary = await backend.getArchitecture('src/', 'summary');
    assert.equal(typeof summary.totalFiles, 'number');
  });

  await t.test('gracefully handles empty response fields', async () => {
    response = () => jsonResult({});

    const result = await backend.getArchitecture();
    assert.deepEqual(result.languages, {});
    assert.equal(result.packages.length, 0);
    assert.equal(result.hotspots.length, 0);
    assert.equal(result.totalSymbols, 0);
    assert.equal(result.totalFiles, 0);
  });

  await t.test('non-zero exit throws CodeGraphBackendError', async () => {
    response = () => errorResult('architecture: not indexed yet');

    await assert.rejects(
      () => backend.getArchitecture(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('architecture'));
        return true;
      },
    );
  });

  await t.test('rejected promise propagates rejection message', async () => {
    response = () => rejectionResult('timeout exceeded');

    await assert.rejects(
      () => backend.getArchitecture(),
      (err: unknown) => {
        assert.ok((err as Error).message.includes('timeout exceeded'));
        return true;
      },
    );
  });

  await t.test('malformed JSON surfaces as error', async () => {
    response = () => toolResult(0, '[[[');

    await assert.rejects(
      () => backend.getArchitecture(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        assert.ok((err as CodeGraphBackendError).message.includes('get_architecture'));
        return true;
      },
    );
  });
});

// ── kg_index_status ──────────────────────────────────────────────────────────

test('kg_index_status', async (t) => {
  let response = (): ToolResult | Promise<ToolResult> => jsonResult({});
  const backend = createBackend(() => response());

  await t.test('success returns ready status with node/edge counts', async () => {
    response = () =>
      jsonResult({
        status: 'ready',
        node_count: 1234,
        edge_count: 5678,
        last_indexed_timestamp: 1718400000,
      });

    const result: IndexStatus = await backend.getIndexStatus();
    assert.equal(result.status, 'ready');
    assert.equal(result.nodeCount, 1234);
    assert.equal(result.edgeCount, 5678);
    assert.equal(result.lastIndexedTimestamp, 1718400000);
  });

  await t.test('success returns stale status', async () => {
    response = () => jsonResult({
      status: 'stale',
      node_count: 100,
      edge_count: 50,
    });

    const result = await backend.getIndexStatus();
    assert.equal(result.status, 'stale');
  });

  // ── C9: empty-vs-throw distinction ────────────────────────────────────

  await t.test('C9: non-zero exit with empty stderr returns status empty (does not throw)', async () => {
    response = () => toolResult(1, '', '');

    const result = await backend.getIndexStatus();
    assert.equal(result.status, 'empty');
    assert.equal(result.nodeCount, undefined);
    assert.equal(result.edgeCount, undefined);
    assert.equal(result.lastIndexedTimestamp, undefined);
  });

  await t.test('C9: non-zero exit with non-empty stderr throws CodeGraphBackendError', async () => {
    response = () => errorResult('codebase-memory-mcp binary not found');

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

  await t.test('C9: handles missing stdout fields — defaults status to empty', async () => {
    response = () => jsonResult({});

    const result = await backend.getIndexStatus();
    assert.equal(result.status, 'empty');
    assert.equal(result.nodeCount, undefined);
    assert.equal(result.edgeCount, undefined);
  });

  await t.test('C9: non-zero exit with empty stderr on different error codes', async () => {
    // exit code 127 = command not found, 137 = SIGKILL
    for (const code of [127, 137, 2, -1]) {
      response = () => toolResult(code, '', '');
      const result = await backend.getIndexStatus();
      assert.equal(
        result.status,
        'empty',
        `exit code ${code} should yield 'empty' status`,
      );
      assert.equal(result.nodeCount, undefined);
    }
  });

  await t.test('C9: non-zero exit with whitespace-only stderr throws (truthy check)', async () => {
    // The implementation checks result.stderr for truthiness, so whitespace-only
    // stderr is treated as non-empty and throws. This is a conscious design choice
    // documented here for the C9 audit trail.
    response = () => toolResult(1, '', '  \n  \t  ');

    await assert.rejects(
      () => backend.getIndexStatus(),
      (err: unknown) => {
        assert.ok(err instanceof CodeGraphBackendError);
        return true;
      },
    );
  });

  await t.test('rejected promise propagates rejection message', async () => {
    response = () => rejectionResult('transport error');

    await assert.rejects(
      () => backend.getIndexStatus(),
      (err: unknown) => {
        assert.ok((err as Error).message.includes('transport error'));
        return true;
      },
    );
  });

  await t.test('malformed JSON in stdout surfaces as error', async () => {
    response = () => toolResult(0, 'not json at all');

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
});

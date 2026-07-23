/**
 * toolRenderers.test.ts — Tests for tool-specific grouped renderers.
 *
 * Tests verify:
 * 1. Each built-in renderer's renderRunning, renderComplete, renderError
 * 2. ToolRendererRegistry pattern (register, get, has, resolve, fallback)
 * 3. ToolGroupRenderer (add, render, update, finalize, grouping)
 * 4. Edge cases (empty input, missing fields, error states)
 *
 * Run: npx tsx --test src/ui/toolRenderers.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from './theme.js';
import {
  ReadFileRenderer,
  WriteFileRenderer,
  BashRenderer,
  GrepRenderer,
  WebFetchRenderer,
  WebSearchRenderer,
  SubAgentRenderer,
  GenericToolRenderer,
  ToolRendererRegistry,
  ToolGroupRenderer,
  defaultToolRegistry,
  type ToolRenderContext,
  type ToolRenderer,
} from './toolRenderers.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a basic ToolRenderContext fixture. */
function makeContext(overrides: Partial<ToolRenderContext> & { toolName?: string }): ToolRenderContext {
  const ctx: ToolRenderContext = {
    toolId: overrides.toolId ?? 'test-1',
    toolName: overrides.toolName ?? 'test',
    toolInput: overrides.toolInput ?? {},
    status: overrides.status ?? 'running',
  };
  if (overrides.result !== undefined) ctx.result = overrides.result;
  if (overrides.error !== undefined) ctx.error = overrides.error;
  if (overrides.durationMs !== undefined) ctx.durationMs = overrides.durationMs;
  return ctx;
}

/** Strip ANSI codes and collapse whitespace for easier matching. */
function clean(text: string): string {
  return stripAnsi(text).replace(/\s+/g, ' ').trim();
}

/** Strip ANSI codes only, preserving newlines. */
function strip(text: string): string {
  return stripAnsi(text);
}

// ═══════════════════════════════════════════════════════════════════════════
// ReadFileRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('ReadFileRenderer.renderRunning shows filename', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'src/index.ts' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Reading/);
  assert.match(out, /src\/index\.ts/);
});

test('ReadFileRenderer.renderRunning falls back to filePath key', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { filePath: 'src/main.ts' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /src\/main\.ts/);
});

test('ReadFileRenderer.renderComplete shows line count', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'src/index.ts' },
    status: 'complete',
    result: 'line1\nline2\nline3\nline4\n',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Read/);
  assert.match(out, /src\/index\.ts/);
  assert.match(out, /4 lines/);
});

test('ReadFileRenderer.renderComplete with explicit lineCount in input', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'src/index.ts', lineCount: 42 },
    status: 'complete',
    result: 'line1\nline2\nline3\n',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /42 lines/);
});

test('ReadFileRenderer.renderComplete shows preview snippet', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'src/index.ts' },
    status: 'complete',
    result: 'line1\nline2\nline3\nline4\nline5\nline6',
  });
  const out = strip(renderer.renderComplete(ctx));
  // Should show at most maxResultLines (5) lines of preview
  assert.match(out, /line1/);
  assert.match(out, /line5/);
  assert.ok(out.includes('more lines'), 'should show overflow indicator');
});

test('ReadFileRenderer.renderError shows error message', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'src/index.ts' },
    status: 'error',
    error: 'ENOENT: no such file',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Failed/);
  assert.match(out, /src\/index\.ts/);
  assert.match(out, /ENOENT/);
});

test('ReadFileRenderer.renderError with unknown path', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: {},
    status: 'error',
    error: 'permission denied',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Failed/);
  assert.match(out, /unknown/);
});

test('ReadFileRenderer.showResult is true', () => {
  const renderer = new ReadFileRenderer();
  assert.equal(renderer.showResult, true);
  assert.equal(renderer.maxResultLines, 5);
});

test('ReadFileRenderer.renderComplete handles missing result gracefully', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'src/index.ts' },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Read/);
  assert.match(out, /src\/index\.ts/);
});

// ═══════════════════════════════════════════════════════════════════════════
// WriteFileRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('WriteFileRenderer.renderRunning shows filename', () => {
  const renderer = new WriteFileRenderer();
  const ctx = makeContext({
    toolName: 'Write',
    toolInput: { path: 'src/new.ts' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Writing/);
  assert.match(out, /src\/new\.ts/);
});

test('WriteFileRenderer.renderComplete shows diff summary', () => {
  const renderer = new WriteFileRenderer();
  const ctx = makeContext({
    toolName: 'Write',
    toolInput: { path: 'src/new.ts', additions: 15, deletions: 3 },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Written/);
  assert.match(out, /src\/new\.ts/);
  assert.match(out, /\+15/);
  assert.match(out, /−3/);
});

test('WriteFileRenderer.renderComplete with only additions', () => {
  const renderer = new WriteFileRenderer();
  const ctx = makeContext({
    toolName: 'Write',
    toolInput: { path: 'src/new.ts', added: 10 },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /\+10/);
});

test('WriteFileRenderer.renderComplete with content preview', () => {
  const renderer = new WriteFileRenderer();
  const ctx = makeContext({
    toolName: 'Write',
    toolInput: { path: 'src/new.ts', content: 'line1\nline2\nline3' },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /line1/);
  assert.match(out, /line3/);
});

test('WriteFileRenderer.renderComplete with duration', () => {
  const renderer = new WriteFileRenderer();
  const ctx = makeContext({
    toolName: 'Write',
    toolInput: { path: 'src/new.ts' },
    status: 'complete',
    durationMs: 5230,
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /5\.2s/);
});

test('WriteFileRenderer.renderError shows error', () => {
  const renderer = new WriteFileRenderer();
  const ctx = makeContext({
    toolName: 'Write',
    toolInput: { path: 'src/new.ts' },
    status: 'error',
    error: 'disk full',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Failed/);
  assert.match(out, /disk full/);
});

test('WriteFileRenderer.showResult is false', () => {
  const renderer = new WriteFileRenderer();
  assert.equal(renderer.showResult, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// BashRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('BashRenderer.renderRunning shows command', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Running/);
  assert.match(out, /npm test/);
});

test('BashRenderer.renderRunning with cmd alias', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { cmd: 'ls -la' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /ls -la/);
});

test('BashRenderer.renderRunning with script alias', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { script: 'deploy.sh' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /deploy\.sh/);
});

test('BashRenderer.renderComplete shows exit code 0', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'npm test', exitCode: 0 },
    status: 'complete',
    result: 'PASS tests/foo\nPASS tests/bar\n',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /npm test/);
  assert.match(out, /0/); // exit code 0
  assert.match(out, /PASS tests\/foo/);
});

test('BashRenderer.renderComplete shows output summary', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    status: 'complete',
    result: 'line1\nline2\nline3\nline4',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /line1/);
  assert.match(out, /line3/);
  assert.ok(out.includes('more lines'), 'should show overflow');
});

test('BashRenderer.renderComplete with non-zero exit code via input', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'failing-cmd', exitCode: 1 },
    status: 'complete',
    result: 'Error: something broke',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /1/);
});

test('BashRenderer.renderError shows exit code and error', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'bad-cmd', exitCode: 127 },
    status: 'error',
    error: 'command not found',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /bad-cmd/);
  assert.match(out, /exit 127/);
  assert.match(out, /command not found/);
});

test('BashRenderer.renderError with exit_code alias', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'bad-cmd', exit_code: 2 },
    status: 'error',
    error: 'syntax error',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /exit 2/);
});

// ═══════════════════════════════════════════════════════════════════════════
// GrepRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('GrepRenderer.renderRunning shows pattern', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'function' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Searching for/);
  assert.match(out, /function/);
});

test('GrepRenderer.renderRunning with query alias', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { query: 'TODO' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /TODO/);
});

test('GrepRenderer.renderComplete shows match count', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'function' },
    status: 'complete',
    result: 'Found 5 matches in 3 files\nsrc/index.ts\nsrc/main.ts\nsrc/utils.ts',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Found/);
  assert.match(out, /5 matches/);
  assert.match(out, /3 files/);
  assert.match(out, /src\/index\.ts/);
});

test('GrepRenderer.renderComplete with explicit matchCount', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'function', matchCount: 12 },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /12/);
});

test('GrepRenderer.renderComplete single match singular', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'unique_fn', matchCount: 1 },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /1 match/);
});

test('GrepRenderer.renderCompact no result', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'nothing' },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Found/);
});

test('GrepRenderer.renderError', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'foo' },
    status: 'error',
    error: 'invalid regex',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Search failed/);
  assert.match(out, /foo/);
  assert.match(out, /invalid regex/);
});

test('GrepRenderer.renderComplete with file list overflow', () => {
  const renderer = new GrepRenderer();
  const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'import' },
    status: 'complete',
    result: `Found ${files.length} matches\n${files.join('\n')}`,
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.ok(out.includes('more files'), 'should show overflow indicator');
});

// ═══════════════════════════════════════════════════════════════════════════
// WebFetchRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('WebFetchRenderer.renderRunning shows URL', () => {
  const renderer = new WebFetchRenderer();
  const ctx = makeContext({
    toolName: 'WebFetch',
    toolInput: { url: 'https://example.com/api' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Fetching/);
  assert.match(out, /example\.com/);
});

test('WebFetchRenderer.renderComplete shows status code', () => {
  const renderer = new WebFetchRenderer();
  const ctx = makeContext({
    toolName: 'WebFetch',
    toolInput: { url: 'https://example.com/api', statusCode: 200 },
    status: 'complete',
    result: '{"ok": true}',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Fetched/);
  assert.match(out, /200/);
});

test('WebFetchRenderer.renderComplete with content length', () => {
  const renderer = new WebFetchRenderer();
  const ctx = makeContext({
    toolName: 'WebFetch',
    toolInput: { url: 'https://example.com/data', contentLength: 1536 },
    status: 'complete',
    result: 'x'.repeat(1536),
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /1\.5 KB/);
});

test('WebFetchRenderer.renderComplete with 404 status', () => {
  const renderer = new WebFetchRenderer();
  const ctx = makeContext({
    toolName: 'WebFetch',
    toolInput: { url: 'https://example.com/notfound', status: 404 },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /404/);
});

test('WebFetchRenderer.renderError', () => {
  const renderer = new WebFetchRenderer();
  const ctx = makeContext({
    toolName: 'WebFetch',
    toolInput: { url: 'https://example.com/bad' },
    status: 'error',
    error: 'connection refused',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Failed to fetch/);
  assert.match(out, /connection refused/);
});

// ═══════════════════════════════════════════════════════════════════════════
// WebSearchRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('WebSearchRenderer.renderRunning shows query', () => {
  const renderer = new WebSearchRenderer();
  const ctx = makeContext({
    toolName: 'WebSearch',
    toolInput: { query: 'latest TypeScript news' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Searching for/);
  assert.match(out, /TypeScript/);
});

test('WebSearchRenderer.renderComplete shows result count', () => {
  const renderer = new WebSearchRenderer();
  const ctx = makeContext({
    toolName: 'WebSearch',
    toolInput: { query: 'node.js performance', resultCount: 8 },
    status: 'complete',
    result: 'Result 1: ...\nResult 2: ...\n',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Found/);
  assert.match(out, /8 results/);
});

test('WebSearchRenderer.renderComplete with result titles', () => {
  const renderer = new WebSearchRenderer();
  const ctx = makeContext({
    toolName: 'WebSearch',
    toolInput: { query: 'testing' },
    status: 'complete',
    result: 'Title 1 - some description\nTitle 2 - more info',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Title 1/);
  assert.match(out, /Title 2/);
});

test('WebSearchRenderer.renderComplete single result singular', () => {
  const renderer = new WebSearchRenderer();
  const ctx = makeContext({
    toolName: 'WebSearch',
    toolInput: { query: 'specific thing', resultCount: 1 },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /result/);
});

test('WebSearchRenderer.renderError', () => {
  const renderer = new WebSearchRenderer();
  const ctx = makeContext({
    toolName: 'WebSearch',
    toolInput: { query: 'something' },
    status: 'error',
    error: 'rate limited',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Search failed/);
  assert.match(out, /rate limited/);
});

test('WebSearchRenderer.renderComplete with no result', () => {
  const renderer = new WebSearchRenderer();
  const ctx = makeContext({
    toolName: 'WebSearch',
    toolInput: { query: 'nothing found' },
    status: 'complete',
    result: '',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /for/);
  assert.match(out, /nothing found/);
});

// ═══════════════════════════════════════════════════════════════════════════
// SubAgentRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('SubAgentRenderer.renderRunning shows agent name and task', () => {
  const renderer = new SubAgentRenderer();
  const ctx = makeContext({
    toolName: 'SubAgent',
    toolInput: { agentName: 'Researcher', task: 'Find potential bugs' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /Agent/);
  assert.match(out, /Researcher/);
  assert.match(out, /Find potential bugs/);
});

test('SubAgentRenderer.renderRunning with agent alias', () => {
  const renderer = new SubAgentRenderer();
  const ctx = makeContext({
    toolName: 'SubAgent',
    toolInput: { agent: 'CodeReviewer', objective: 'Review PR #42' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /CodeReviewer/);
  assert.match(out, /Review PR #42/);
});

test('SubAgentRenderer.renderComplete shows completion', () => {
  const renderer = new SubAgentRenderer();
  const ctx = makeContext({
    toolName: 'SubAgent',
    toolInput: { agentName: 'Explorer' },
    status: 'complete',
    result: 'Found 3 potential issues in main.ts',
    durationMs: 4500,
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /Agent/);
  assert.match(out, /Explorer/);
  assert.match(out, /Found 3/);
  assert.match(out, /4\.5s/);
});

test('SubAgentRenderer.renderError', () => {
  const renderer = new SubAgentRenderer();
  const ctx = makeContext({
    toolName: 'SubAgent',
    toolInput: { agentName: 'Builder', task: 'Build project' },
    status: 'error',
    error: 'build failed with 2 errors',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /Builder/);
  assert.match(out, /build failed/);
});

test('SubAgentRenderer.falls back to toolName for agent name', () => {
  const renderer = new SubAgentRenderer();
  const ctx = makeContext({
    toolName: 'CodeReviewSubAgent',
    toolInput: {},
  });
  const out = clean(renderer.renderRunning(ctx));
  // Should use context.toolName as fallback agent name
  assert.match(out, /CodeReviewSubAgent/);
});

// ═══════════════════════════════════════════════════════════════════════════
// GenericToolRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('GenericToolRenderer.renderRunning shows tool name', () => {
  const renderer = new GenericToolRenderer();
  const ctx = makeContext({
    toolName: 'CustomTool',
    toolInput: { arg1: 'val1' },
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /CustomTool/);
  assert.match(out, /arg1/);
});

test('GenericToolRenderer.renderRunning with empty input', () => {
  const renderer = new GenericToolRenderer();
  const ctx = makeContext({
    toolName: 'CustomTool',
    toolInput: {},
  });
  const out = clean(renderer.renderRunning(ctx));
  assert.match(out, /CustomTool/);
});

test('GenericToolRenderer.renderComplete shows success checkmark', () => {
  const renderer = new GenericToolRenderer();
  const ctx = makeContext({
    toolName: 'CustomTool',
    toolInput: {},
    status: 'complete',
    result: 'Operation completed successfully',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /CustomTool/);
  assert.match(out, /Operation completed/);
});

test('GenericToolRenderer.renderComplete with duration', () => {
  const renderer = new GenericToolRenderer();
  const ctx = makeContext({
    toolName: 'CustomTool',
    toolInput: {},
    status: 'complete',
    durationMs: 1234,
    result: 'done',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /1\.2s/);
});

test('GenericToolRenderer.renderError', () => {
  const renderer = new GenericToolRenderer();
  const ctx = makeContext({
    toolName: 'CustomTool',
    toolInput: {},
    status: 'error',
    error: 'unexpected error occurred',
  });
  const out = clean(renderer.renderError(ctx));
  assert.match(out, /CustomTool/);
  assert.match(out, /unexpected error occurred/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ToolRendererRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('ToolRendererRegistry.register and get', () => {
  const registry = new ToolRendererRegistry();
  const renderer = new ReadFileRenderer();
  registry.register(renderer);
  assert.equal(registry.get('Read'), renderer);
  assert.equal(registry.get('read'), renderer);
  assert.equal(registry.get('READ'), renderer);
});

test('ToolRendererRegistry.has', () => {
  const registry = new ToolRendererRegistry();
  assert.equal(registry.has('Read'), false);
  registry.register(new ReadFileRenderer());
  assert.equal(registry.has('Read'), true);
  assert.equal(registry.has('read'), true);
});

test('ToolRendererRegistry.get returns undefined for unknown', () => {
  const registry = new ToolRendererRegistry();
  assert.equal(registry.get('Nonexistent'), undefined);
});

test('ToolRendererRegistry.resolve exact match', () => {
  const registry = new ToolRendererRegistry();
  const readRenderer = new ReadFileRenderer();
  registry.register(readRenderer);
  assert.equal(registry.resolve('Read'), readRenderer);
});

test('ToolRendererRegistry.resolve case-insensitive exact match', () => {
  const registry = new ToolRendererRegistry();
  const readRenderer = new ReadFileRenderer();
  registry.register(readRenderer);
  assert.equal(registry.resolve('read'), readRenderer);
  assert.equal(registry.resolve('READ'), readRenderer);
});

test('ToolRendererRegistry.resolve fuzzy match (toolName includes key)', () => {
  const registry = new ToolRendererRegistry();
  const bashRenderer = new BashRenderer();
  registry.register(bashRenderer);
  // "shell_exec" should fuzzy-match "bash" via includes check
  assert.equal(registry.resolve('shell_exec'), bashRenderer);
});

test('ToolRendererRegistry.resolve alias match (file_read → Read)', () => {
  const registry = new ToolRendererRegistry();
  const readRenderer = new ReadFileRenderer();
  registry.register(readRenderer);
  assert.equal(registry.resolve('file_read'), readRenderer);
});

test('ToolRendererRegistry.resolve alias match (shell → Bash)', () => {
  const registry = new ToolRendererRegistry();
  const bashRenderer = new BashRenderer();
  registry.register(bashRenderer);
  assert.equal(registry.resolve('shell'), bashRenderer);
});

test('ToolRendererRegistry.resolve alias match (search_web → WebSearch)', () => {
  const registry = new ToolRendererRegistry();
  const searchRenderer = new WebSearchRenderer();
  registry.register(searchRenderer);
  assert.equal(registry.resolve('search_web'), searchRenderer);
});

test('ToolRendererRegistry.resolve falls back to GenericToolRenderer', () => {
  const registry = new ToolRendererRegistry();
  registry.register(new GenericToolRenderer());
  const result = registry.resolve('UnknownTool');
  assert.ok(result instanceof GenericToolRenderer);
});

test('ToolRendererRegistry.resolve creates GenericToolRenderer if none registered', () => {
  const registry = new ToolRendererRegistry();
  // No generic registered — resolve should auto-create one
  const result = registry.resolve('MysteryTool');
  assert.ok(result instanceof GenericToolRenderer);
});

test('ToolRendererRegistry multiple renderers', () => {
  const registry = new ToolRendererRegistry();
  const read = new ReadFileRenderer();
  const write = new WriteFileRenderer();
  const bash = new BashRenderer();
  registry.register(read);
  registry.register(write);
  registry.register(bash);

  assert.equal(registry.resolve('Read'), read);
  assert.equal(registry.resolve('Write'), write);
  assert.equal(registry.resolve('Bash'), bash);
});

test('ToolRendererRegistry resolve with webfetch alias', () => {
  const registry = new ToolRendererRegistry();
  const fetchRenderer = new WebFetchRenderer();
  registry.register(fetchRenderer);
  assert.equal(registry.resolve('web_fetch'), fetchRenderer);
  assert.equal(registry.resolve('fetch_url'), fetchRenderer);
  assert.equal(registry.resolve('http_get'), fetchRenderer);
});

test('ToolRendererRegistry resolve with subagent alias', () => {
  const registry = new ToolRendererRegistry();
  const agentRenderer = new SubAgentRenderer();
  registry.register(agentRenderer);
  assert.equal(registry.resolve('agent'), agentRenderer);
  assert.equal(registry.resolve('delegate'), agentRenderer);
});

// ═══════════════════════════════════════════════════════════════════════════
// ToolGroupRenderer
// ═══════════════════════════════════════════════════════════════════════════

test('ToolGroupRenderer.addTool adds tools to group', () => {
  const group = new ToolGroupRenderer();
  assert.equal(group.size, 0);
  group.addTool(makeContext({ toolId: 'read-1', toolName: 'Read', toolInput: { path: 'a.ts' } }));
  assert.equal(group.size, 1);
  group.addTool(makeContext({ toolId: 'read-2', toolName: 'Read', toolInput: { path: 'b.ts' } }));
  assert.equal(group.size, 2);
});

test('ToolGroupRenderer.render returns non-empty for tools', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 'read-1', toolName: 'Read', toolInput: { path: 'a.ts' } }));
  const out = group.render();
  assert.ok(out.length > 0);
  assert.ok(out.includes('parallel tools'));
});

test('ToolGroupRenderer.render empty returns empty string', () => {
  const group = new ToolGroupRenderer();
  assert.equal(group.render(), '');
});

test('ToolGroupRenderer.hasPending returns true when tools running', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'running' }));
  assert.equal(group.hasPending(), true);
});

test('ToolGroupRenderer.hasPending returns false when all complete', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'complete' }));
  group.addTool(makeContext({ toolId: 't2', toolName: 'Write', status: 'complete' }));
  assert.equal(group.hasPending(), false);
});

test('ToolGroupRenderer.hasPending returns false when mixed with errors', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'complete' }));
  group.addTool(makeContext({ toolId: 't2', toolName: 'Bash', status: 'error' }));
  assert.equal(group.hasPending(), false);
});

test('ToolGroupRenderer.updateTool updates existing tool state', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'running' }));
  assert.equal(group.hasPending(), true);
  group.updateTool('t1', { status: 'complete', result: 'file content' });
  assert.equal(group.hasPending(), false);
});

test('ToolGroupRenderer.updateTool ignores unknown toolId', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'running' }));
  // Should not throw
  group.updateTool('nonexistent', { status: 'complete' });
  assert.equal(group.hasPending(), true);
});

test('ToolGroupRenderer.finalize marks group as complete', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'running' }));
  group.finalize();
  assert.equal(group.getStatus(), 'complete');
});

test('ToolGroupRenderer.getStatus returns correct group status', () => {
  const group = new ToolGroupRenderer();
  assert.equal(group.getStatus(), 'complete'); // empty = complete
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'running' }));
  assert.equal(group.getStatus(), 'running');
  group.updateTool('t1', { status: 'complete' });
  assert.equal(group.getStatus(), 'complete');
});

test('ToolGroupRenderer renders all tools in group output', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', toolInput: { path: 'a.ts' }, status: 'complete' }));
  group.addTool(makeContext({ toolId: 't2', toolName: 'Read', toolInput: { path: 'b.ts' }, status: 'running' }));
  const out = strip(group.render());
  assert.match(out, /a\.ts/);
  assert.match(out, /b\.ts/);
  assert.match(out, /parallel tools/);
});

test('ToolGroupRenderer with custom registry resolves via correct renderer', () => {
  const registry = new ToolRendererRegistry();
  const customRenderer: ToolRenderer = {
    toolName: 'Special',
    renderRunning: () => '[[ running special ]]',
    renderComplete: () => '[[ complete special ]]',
    renderError: () => '[[ error special ]]',
    showResult: false,
    maxResultLines: 0,
  };
  registry.register(customRenderer);
  registry.register(new GenericToolRenderer());

  const group = new ToolGroupRenderer(registry);
  group.addTool(makeContext({ toolId: 's1', toolName: 'Special', status: 'complete' }));
  const out = strip(group.render());
  assert.match(out, /complete special/);
});

test('ToolGroupRenderer multiple tools render compact state line per tool', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({
    toolId: 't1', toolName: 'Read', toolInput: { path: 'a.ts' }, status: 'complete',
  }));
  group.addTool(makeContext({
    toolId: 't2', toolName: 'Bash', toolInput: { command: 'ls' }, status: 'running',
  }));
  const out = strip(group.render());
  // Both tools should appear in the output
  assert.match(out, /a\.ts/);
  assert.match(out, /ls/);
});

// ═══════════════════════════════════════════════════════════════════════════
// defaultToolRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('defaultToolRegistry has all built-in renderers', () => {
  assert.ok(defaultToolRegistry.resolve('Read') instanceof ReadFileRenderer);
  assert.ok(defaultToolRegistry.resolve('Write') instanceof WriteFileRenderer);
  assert.ok(defaultToolRegistry.resolve('Bash') instanceof BashRenderer);
  assert.ok(defaultToolRegistry.resolve('Grep') instanceof GrepRenderer);
  assert.ok(defaultToolRegistry.resolve('WebFetch') instanceof WebFetchRenderer);
  assert.ok(defaultToolRegistry.resolve('WebSearch') instanceof WebSearchRenderer);
  assert.ok(defaultToolRegistry.resolve('SubAgent') instanceof SubAgentRenderer);
});

test('defaultToolRegistry resolves common aliases', () => {
  assert.ok(defaultToolRegistry.resolve('file_read') instanceof ReadFileRenderer);
  assert.ok(defaultToolRegistry.resolve('file_write') instanceof WriteFileRenderer);
  assert.ok(defaultToolRegistry.resolve('shell_exec') instanceof BashRenderer);
  assert.ok(defaultToolRegistry.resolve('grep_search') instanceof GrepRenderer);
  assert.ok(defaultToolRegistry.resolve('web_fetch') instanceof WebFetchRenderer);
  assert.ok(defaultToolRegistry.resolve('web_search') instanceof WebSearchRenderer);
  assert.ok(defaultToolRegistry.resolve('agent') instanceof SubAgentRenderer);
});

test('defaultToolRegistry falls back to generic for unknown tools', () => {
  const result = defaultToolRegistry.resolve('TotallyMadeUpToolName');
  assert.ok(result instanceof GenericToolRenderer);
});

test('defaultToolRegistry.resolve returns renderer for known tools by any casing', () => {
  assert.ok(defaultToolRegistry.resolve('read') instanceof ReadFileRenderer);
  assert.ok(defaultToolRegistry.resolve('BASH') instanceof BashRenderer);
  assert.ok(defaultToolRegistry.resolve('GREP') instanceof GrepRenderer);
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases and error handling
// ═══════════════════════════════════════════════════════════════════════════

test('all renderers handle empty context gracefully', () => {
  const renderer = new GenericToolRenderer();
  const ctx = makeContext({ toolName: '', toolInput: {}, status: 'running' });
  // Should not throw
  const out = renderer.renderRunning(ctx);
  assert.ok(typeof out === 'string');
});

test('all renderers handle undefined result', () => {
  const renderer = new ReadFileRenderer();
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: 'test.ts' },
    status: 'complete',
  });
  // Should not throw
  const out = renderer.renderComplete(ctx);
  assert.ok(typeof out === 'string');
});

test('ToolGroupRenderer with tools of different types', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 'r1', toolName: 'Read', toolInput: { path: 'a.ts' }, status: 'complete' }));
  group.addTool(makeContext({ toolId: 'b1', toolName: 'Bash', toolInput: { command: 'npm test' }, status: 'running' }));
  group.addTool(makeContext({ toolId: 's1', toolName: 'SubAgent', toolInput: { agentName: 'Researcher' }, status: 'running' }));
  const out = strip(group.render());
  assert.match(out, /a\.ts/);
  assert.match(out, /npm test/);
  assert.match(out, /Researcher/);
  assert.match(out, /3 parallel tools/);
});

test('registry resolve preserves GenericToolRenderer for unrecognized tool', () => {
  const registry = new ToolRendererRegistry();
  registry.register(new GenericToolRenderer());
  const result = registry.resolve('SomeRandomTool');
  assert.ok(result instanceof GenericToolRenderer);
  assert.equal(result.toolName, '*');
});

test('ReadFileRenderer long path truncation', () => {
  const renderer = new ReadFileRenderer();
  const longPath = 'a/' .repeat(50) + 'file.ts';
  const ctx = makeContext({
    toolName: 'Read',
    toolInput: { path: longPath },
    status: 'complete',
    result: 'content',
  });
  // Should not throw and produce valid output
  const out = renderer.renderComplete(ctx);
  assert.ok(typeof out === 'string');
  assert.ok(out.length > 0);
});

test('BashRenderer long command truncation', () => {
  const renderer = new BashRenderer();
  const longCmd = 'echo ' + 'very-long-argument-'.repeat(20);
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: longCmd },
    status: 'running',
  });
  const out = renderer.renderRunning(ctx);
  assert.ok(typeof out === 'string');
});

test('BashRenderer renderComplete with no result', () => {
  const renderer = new BashRenderer();
  const ctx = makeContext({
    toolName: 'Bash',
    toolInput: { command: 'echo hi' },
    status: 'complete',
  });
  const out = strip(renderer.renderComplete(ctx));
  assert.match(out, /echo/);
});

test('GrepRenderer with no matches has empty file list', () => {
  const renderer = new GrepRenderer();
  const ctx = makeContext({
    toolName: 'Grep',
    toolInput: { pattern: 'nonexistent' },
    status: 'complete',
    result: 'No matches found',
  });
  // Should not show file list
  const out = strip(renderer.renderComplete(ctx));
  assert.ok(typeof out === 'string');
});

test('ToolRendererRegistry multiple registrations override previous', () => {
  const registry = new ToolRendererRegistry();
  const r1 = new ReadFileRenderer();
  const r2 = new ReadFileRenderer();
  registry.register(r1);
  registry.register(r2);
  assert.equal(registry.get('Read'), r2);
});

test('ToolGroupRenderer getStatus returns complete after finalize', () => {
  const group = new ToolGroupRenderer();
  group.addTool(makeContext({ toolId: 't1', toolName: 'Read', status: 'running' }));
  assert.equal(group.getStatus(), 'running');
  group.finalize();
  assert.equal(group.getStatus(), 'complete');
});

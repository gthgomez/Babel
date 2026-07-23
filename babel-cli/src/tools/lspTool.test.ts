/**
 * LSP Tool Tests — schema validation and formatter output.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LspToolInputSchema } from './lspTool.js';
import { LSP_OPERATIONS } from '../services/lsp/types.js';

import {
  formatGoToDefinitionResult,
  formatFindReferencesResult,
  formatHoverResult,
  formatDocumentSymbolResult,
  formatWorkspaceSymbolResult,
  formatPrepareCallHierarchyResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
} from './lspFormatters.js';

import type {
  Location,
  Hover,
  DocumentSymbol,
  SymbolInformation,
  SymbolKind,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  LocationLink,
} from '../services/lsp/types.js';

describe('LspToolInputSchema', () => {
  test('accepts valid goToDefinition input', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'goToDefinition',
      filePath: '/project/src/index.ts',
      line: 10,
      character: 5,
    });
    assert.ok(result.success);
  });

  test('accepts valid hover input', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'hover',
      filePath: '/project/src/index.ts',
      line: 42,
      character: 15,
    });
    assert.ok(result.success);
  });

  test('accepts valid documentSymbol input (no position needed)', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'documentSymbol',
      filePath: '/project/src/index.ts',
    });
    assert.ok(result.success);
  });

  test('accepts valid workspaceSymbol input with query', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'workspaceSymbol',
      filePath: '/project/src/index.ts',
      query: 'foo',
    });
    assert.ok(result.success);
  });

  test('accepts valid workspaceSymbol without query (server defaults to empty)', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'workspaceSymbol',
      filePath: '/project/src/index.ts',
    });
    assert.ok(result.success);
  });

  test('rejects empty filePath', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'documentSymbol',
      filePath: '',
    });
    assert.equal(result.success, false);
  });

  test('rejects invalid operation', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'invalidOp',
      filePath: '/project/src/index.ts',
    });
    assert.equal(result.success, false);
  });

  test('rejects negative line number', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'goToDefinition',
      filePath: '/project/src/index.ts',
      line: -1,
      character: 5,
    });
    assert.equal(result.success, false);
  });

  test('rejects non-integer character', () => {
    const result = LspToolInputSchema.safeParse({
      operation: 'goToDefinition',
      filePath: '/project/src/index.ts',
      line: 10,
      character: 5.5,
    });
    assert.equal(result.success, false);
  });

  test('line and character are optional for non-positional ops', () => {
    for (const op of ['documentSymbol', 'workspaceSymbol'] as const) {
      const result = LspToolInputSchema.safeParse({
        operation: op,
        filePath: '/project/src/index.ts',
      });
      assert.ok(result.success, `Operation ${op} should not require line/character`);
    }
  });

  test('accepts all valid LSP operations', () => {
    for (const op of LSP_OPERATIONS) {
      const input: Record<string, unknown> = {
        operation: op,
        filePath: '/project/src/index.ts',
      };
      if (op !== 'documentSymbol' && op !== 'workspaceSymbol') {
        input.line = 1;
        input.character = 1;
      }
      const result = LspToolInputSchema.safeParse(input);
      assert.ok(result.success, `Operation "${op}" should be valid`);
    }
  });
});

describe('LSP Formatters', () => {
  const cwd = '/project';

  describe('formatGoToDefinitionResult', () => {
    test('formats single Location', () => {
      const loc: Location = {
        uri: 'file:///project/src/foo.ts',
        range: {
          start: { line: 10, character: 5 },
          end: { line: 10, character: 20 },
        },
      };
      const result = formatGoToDefinitionResult(loc, cwd);
      assert.ok(result.includes('src/foo.ts:11:6'));
    });

    test('formats null result as "not found"', () => {
      const result = formatGoToDefinitionResult(null, cwd);
      assert.ok(result.includes('No definition found'));
    });

    test('formats LocationLink', () => {
      const link: LocationLink = {
        targetUri: 'file:///project/src/bar.ts',
        targetRange: {
          start: { line: 5, character: 0 },
          end: { line: 5, character: 10 },
        },
        targetSelectionRange: {
          start: { line: 5, character: 0 },
          end: { line: 5, character: 10 },
        },
      };
      const result = formatGoToDefinitionResult(link, cwd);
      assert.ok(result.includes('src/bar.ts:6:1'));
    });

    test('formats array of Locations', () => {
      const locs: Location[] = [
        {
          uri: 'file:///project/src/foo.ts',
          range: { start: { line: 10, character: 5 }, end: { line: 10, character: 20 } },
        },
        {
          uri: 'file:///project/src/bar.ts',
          range: { start: { line: 42, character: 0 }, end: { line: 42, character: 15 } },
        },
      ];
      const result = formatGoToDefinitionResult(locs, cwd);
      assert.ok(result.includes('Found 2 definitions'));
      assert.ok(result.includes('src/foo.ts:11:6'));
      assert.ok(result.includes('src/bar.ts:43:1'));
    });
  });

  describe('formatFindReferencesResult', () => {
    test('formats empty result', () => {
      const result = formatFindReferencesResult(null, cwd);
      assert.ok(result.includes('No references found'));
    });

    test('formats single reference', () => {
      const locs: Location[] = [
        {
          uri: 'file:///project/src/foo.ts',
          range: { start: { line: 10, character: 5 }, end: { line: 10, character: 20 } },
        },
      ];
      const result = formatFindReferencesResult(locs, cwd);
      assert.ok(result.includes('Found 1 reference'));
      assert.ok(result.includes('src/foo.ts:11:6'));
    });

    test('formats multiple references grouped by file', () => {
      const locs: Location[] = [
        {
          uri: 'file:///project/src/foo.ts',
          range: { start: { line: 10, character: 5 }, end: { line: 10, character: 20 } },
        },
        {
          uri: 'file:///project/src/foo.ts',
          range: { start: { line: 42, character: 0 }, end: { line: 42, character: 15 } },
        },
        {
          uri: 'file:///project/src/bar.ts',
          range: { start: { line: 5, character: 3 }, end: { line: 5, character: 10 } },
        },
      ];
      const result = formatFindReferencesResult(locs, cwd);
      assert.ok(result.includes('3 references'));
      assert.ok(result.includes('2 files'));
      assert.ok(result.includes('Line 11'));
      assert.ok(result.includes('Line 43'));
      assert.ok(result.includes('Line 6'));
    });
  });

  describe('formatHoverResult', () => {
    test('formats null result', () => {
      const result = formatHoverResult(null, cwd);
      assert.ok(result.includes('No hover information'));
    });

    test('formats MarkupContent hover', () => {
      const hover: Hover = {
        contents: {
          kind: 'markdown',
          value: '```typescript\nconst x: number\n```\n\nA numeric value.',
        },
        range: {
          start: { line: 5, character: 10 },
          end: { line: 5, character: 11 },
        },
      };
      const result = formatHoverResult(hover, cwd);
      assert.ok(result.includes('Hover info at 6:11'));
      assert.ok(result.includes('numeric'));
    });

    test('formats string hover contents', () => {
      const hover: Hover = {
        contents: 'Some hover text',
      };
      const result = formatHoverResult(hover, cwd);
      assert.equal(result, 'Some hover text');
    });
  });

  describe('formatDocumentSymbolResult', () => {
    test('formats empty result', () => {
      const result = formatDocumentSymbolResult(null, cwd);
      assert.ok(result.includes('No symbols found'));
    });

    test('formats hierarchical DocumentSymbols', () => {
      const symbols: DocumentSymbol[] = [
        {
          name: 'MyClass',
          kind: 5 as SymbolKind, // Class
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
          children: [
            {
              name: 'myMethod',
              kind: 6 as SymbolKind, // Method
              range: { start: { line: 5, character: 2 }, end: { line: 10, character: 3 } },
              selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } },
            },
          ],
        },
      ];
      const result = formatDocumentSymbolResult(symbols, cwd);
      assert.ok(result.includes('MyClass'));
      assert.ok(result.includes('Class'));
      assert.ok(result.includes('myMethod'));
      assert.ok(result.includes('Method'));
      assert.ok(result.includes('Line 6'));
    });

    test('formats flat SymbolInformation array', () => {
      const symbols: SymbolInformation[] = [
        {
          name: 'foo',
          kind: 12 as SymbolKind,
          location: {
            uri: 'file:///project/src/index.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
          },
          containerName: 'ModuleA',
        },
      ];
      const result = formatDocumentSymbolResult(symbols, cwd);
      assert.ok(result.includes('foo'));
      assert.ok(result.includes('Function'));
      assert.ok(result.includes('src/index.ts'));
    });
  });

  describe('formatWorkspaceSymbolResult', () => {
    test('formats empty result', () => {
      const result = formatWorkspaceSymbolResult(null, cwd);
      assert.ok(result.includes('No symbols found'));
    });

    test('formats symbol list grouped by file', () => {
      const symbols: SymbolInformation[] = [
        {
          name: 'foo',
          kind: 12 as SymbolKind,
          location: {
            uri: 'file:///project/src/index.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
          },
        },
        {
          name: 'bar',
          kind: 5 as SymbolKind,
          location: {
            uri: 'file:///project/src/index.ts',
            range: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
          },
          containerName: 'ModuleA',
        },
      ];
      const result = formatWorkspaceSymbolResult(symbols, cwd);
      assert.ok(result.includes('2 symbol'));
      assert.ok(result.includes('foo'));
      assert.ok(result.includes('bar'));
      assert.ok(result.includes('Class'));
      assert.ok(result.includes('ModuleA'));
    });
  });

  describe('formatPrepareCallHierarchyResult', () => {
    test('formats empty result', () => {
      const result = formatPrepareCallHierarchyResult([], cwd);
      assert.ok(result.includes('No call hierarchy'));
    });

    test('formats single item', () => {
      const items: CallHierarchyItem[] = [
        {
          name: 'myFunction',
          kind: 12 as SymbolKind,
          uri: 'file:///project/src/index.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        },
      ];
      const result = formatPrepareCallHierarchyResult(items, cwd);
      assert.ok(result.includes('myFunction'));
      assert.ok(result.includes('Function'));
      assert.ok(result.includes('src/index.ts:1'));
    });
  });

  describe('formatIncomingCallsResult', () => {
    test('formats empty result', () => {
      const result = formatIncomingCallsResult([], cwd);
      assert.ok(result.includes('No incoming calls'));
    });

    test('formats incoming calls grouped by file', () => {
      const calls: CallHierarchyIncomingCall[] = [
        {
          from: {
            name: 'caller1',
            kind: 12 as SymbolKind,
            uri: 'file:///project/src/caller.ts',
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 20 } },
            selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 7 } },
          },
          fromRanges: [
            { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
          ],
        },
      ];
      const result = formatIncomingCallsResult(calls, cwd);
      assert.ok(result.includes('caller1'));
      assert.ok(result.includes('Function'));
      assert.ok(result.includes('src/caller.ts'));
      assert.ok(result.includes('calls at:'));
    });
  });

  describe('formatOutgoingCallsResult', () => {
    test('formats empty result', () => {
      const result = formatOutgoingCallsResult([], cwd);
      assert.ok(result.includes('No outgoing calls'));
    });

    test('formats outgoing calls grouped by file', () => {
      const calls: CallHierarchyOutgoingCall[] = [
        {
          to: {
            name: 'callee1',
            kind: 6 as SymbolKind,
            uri: 'file:///project/src/callee.ts',
            range: { start: { line: 12, character: 2 }, end: { line: 12, character: 15 } },
            selectionRange: { start: { line: 12, character: 2 }, end: { line: 12, character: 9 } },
          },
          fromRanges: [
            { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
          ],
        },
      ];
      const result = formatOutgoingCallsResult(calls, cwd);
      assert.ok(result.includes('callee1'));
      assert.ok(result.includes('Method'));
      assert.ok(result.includes('src/callee.ts'));
      assert.ok(result.includes('called from:'));
    });
  });
});

/**
 * LSP Tool — code intelligence tool for the Babel executor.
 *
 * Provides go-to-definition, find-references, hover, document symbols,
 * workspace symbols, and go-to-implementation via Language Server Protocol.
 *
 * The tool spawns LSP servers lazily (on first request for a file type)
 * and manages their lifecycle transparently.
 *
 * Read-only tool — never modifies files.
 */

import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { createLspServerManager, type LspServerManager } from '../services/lsp/manager.js';
import type {
  LspOperation,
  Location,
  LocationLink,
  Hover,
  DocumentSymbol,
  SymbolInformation,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  Position,
} from '../services/lsp/types.js';
import { LSP_OPERATIONS } from '../services/lsp/types.js';
import type { ToolResult } from '../sandbox.js';
import type { ToolCallRequest } from '../localTools.js';

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

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max file size in bytes for LSP analysis. */
const MAX_LSP_FILE_SIZE_BYTES = 10_000_000;

// ─── Singleton Manager ───────────────────────────────────────────────────────

let _manager: LspServerManager | null = null;

function getManager(): LspServerManager {
  if (!_manager) {
    _manager = createLspServerManager();
  }
  return _manager;
}

/**
 * Initialize the LSP server manager (called during startup).
 * Safe to call multiple times.
 */
export async function initializeLsp(): Promise<void> {
  const manager = getManager();
  await manager.initialize();
}

/**
 * Shutdown all LSP servers (called during shutdown).
 */
export async function shutdownLsp(): Promise<void> {
  if (_manager) {
    await _manager.shutdown();
    _manager = null;
  }
}

// ─── LSP Tool Input Schema ───────────────────────────────────────────────────

export const LspToolInputSchema = z.object({
  operation: z.enum(LSP_OPERATIONS).describe('The LSP operation to perform'),
  filePath: z.string().min(1).describe('Path to the file to analyze'),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Line number (1-based, required for position-based operations)'),
  character: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Character offset (1-based, required for position-based operations)'),
  query: z
    .string()
    .optional()
    .describe('Search query (used by workspaceSymbol)'),
});

export type LspToolInput = z.infer<typeof LspToolInputSchema>;

// ─── Position-based operations need line+character ───────────────────────────

const POSITION_OPS = new Set<LspOperation>([
  'goToDefinition',
  'findReferences',
  'hover',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
]);

// ─── Convert 1-based (user) to 0-based (LSP) position ───────────────────────

function toLspPosition(line: number, character: number): Position {
  return {
    line: Math.max(0, line - 1),
    character: Math.max(0, character - 1),
  };
}

// ─── Map operation to LSP method + params ────────────────────────────────────

interface MethodAndParams {
  method: string;
  params: unknown;
}

function getMethodAndParams(
  input: LspToolInput,
  absolutePath: string,
): MethodAndParams {
  const uri = pathToFileURL(absolutePath).href;
  const pos = input.line !== undefined && input.character !== undefined
    ? toLspPosition(input.line, input.character)
    : { line: 0, character: 0 };

  switch (input.operation) {
    case 'goToDefinition':
      return {
        method: 'textDocument/definition',
        params: { textDocument: { uri }, position: pos },
      };
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: {
          textDocument: { uri },
          position: pos,
          context: { includeDeclaration: true },
        },
      };
    case 'hover':
      return {
        method: 'textDocument/hover',
        params: { textDocument: { uri }, position: pos },
      };
    case 'documentSymbol':
      return {
        method: 'textDocument/documentSymbol',
        params: { textDocument: { uri } },
      };
    case 'workspaceSymbol':
      return {
        method: 'workspace/symbol',
        params: { query: input.query ?? '' },
      };
    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        params: { textDocument: { uri }, position: pos },
      };
    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: { textDocument: { uri }, position: pos },
      };
  }
}

// ─── Helper: count unique files from locations ───────────────────────────────

function countUniqueFiles(locations: Array<{ uri: string }>): number {
  return new Set(locations.map((loc) => loc.uri)).size;
}

// ─── Helper: count symbols recursively ───────────────────────────────────────

function countSymbols(symbols: DocumentSymbol[]): number {
  let count = symbols.length;
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length > 0) {
      count += countSymbols(symbol.children);
    }
  }
  return count;
}

// ─── Helper: normalize LocationLink → Location ──────────────────────────────

function toLocation(item: Location | LocationLink): Location {
  if ('targetUri' in item) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange || item.targetRange,
    };
  }
  return item;
}

// ─── Format result + compute summary counts ─────────────────────────────────

interface FormattedResult {
  formatted: string;
  resultCount: number;
  fileCount: number;
}

function formatResult(
  operation: LspOperation,
  result: unknown,
  cwd: string,
): FormattedResult {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation': {
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : [];
      const locations = rawResults.map(toLocation).filter((loc) => loc?.uri);
      // goToImplementation returns the same Location/LocationLink shapes as
      // goToDefinition, so we reuse the same formatter.
      const formatter = formatGoToDefinitionResult;
      return {
        formatted: formatter(
          rawResults.length > 0 ? rawResults : null,
          cwd,
        ),
        resultCount: locations.length,
        fileCount: countUniqueFiles(locations),
      };
    }

    case 'findReferences': {
      const locations = (result as Location[])?.filter((loc) => loc?.uri) ?? [];
      return {
        formatted: formatFindReferencesResult(result as Location[] | null, cwd),
        resultCount: locations.length,
        fileCount: countUniqueFiles(locations),
      };
    }

    case 'hover': {
      return {
        formatted: formatHoverResult(result as Hover | null, cwd),
        resultCount: result ? 1 : 0,
        fileCount: result ? 1 : 0,
      };
    }

    case 'documentSymbol': {
      const symbols = (result as (DocumentSymbol | SymbolInformation)[]) ?? [];
      const isDocumentSymbol = symbols.length > 0 && 'range' in (symbols[0] ?? {});
      const count = isDocumentSymbol
        ? countSymbols(symbols as DocumentSymbol[])
        : symbols.length;
      return {
        formatted: formatDocumentSymbolResult(
          result as (DocumentSymbol[] | SymbolInformation[]) | null,
          cwd,
        ),
        resultCount: count,
        fileCount: symbols.length > 0 ? 1 : 0,
      };
    }

    case 'workspaceSymbol': {
      const symbols = (result as SymbolInformation[])?.filter(
        (s) => s?.location?.uri,
      ) ?? [];
      const locations = symbols.map((s) => s.location);
      return {
        formatted: formatWorkspaceSymbolResult(
          result as SymbolInformation[] | null,
          cwd,
        ),
        resultCount: symbols.length,
        fileCount: countUniqueFiles(locations),
      };
    }

    case 'prepareCallHierarchy': {
      const items = (result as CallHierarchyItem[]) ?? [];
      return {
        formatted: formatPrepareCallHierarchyResult(
          result as CallHierarchyItem[] | null,
          cwd,
        ),
        resultCount: items.length,
        fileCount: items.length > 0 ? countUniqueFiles(items) : 0,
      };
    }

    case 'incomingCalls': {
      const calls = (result as CallHierarchyIncomingCall[]) ?? [];
      return {
        formatted: formatIncomingCallsResult(
          result as CallHierarchyIncomingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount: calls.length > 0
          ? new Set(
              calls.map((c) => c.from?.uri).filter((u): u is string => !!u),
            ).size
          : 0,
      };
    }

    case 'outgoingCalls': {
      const calls = (result as CallHierarchyOutgoingCall[]) ?? [];
      return {
        formatted: formatOutgoingCallsResult(
          result as CallHierarchyOutgoingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount: calls.length > 0
          ? new Set(
              calls.map((c) => c.to?.uri).filter((u): u is string => !!u),
            ).size
          : 0,
      };
    }
  }
}

// ─── Input validation ────────────────────────────────────────────────────────

function validateInput(input: LspToolInput): string | null {
  // Validate that position-based operations have line+character
  if (POSITION_OPS.has(input.operation)) {
    if (input.line === undefined || input.character === undefined) {
      return `Operation "${input.operation}" requires line and character parameters.`;
    }
  }

  // Validate workspaceSymbol has a query
  if (input.operation === 'workspaceSymbol' && !input.query) {
    return 'Operation "workspaceSymbol" requires a query parameter.';
  }

  return null;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export interface LspHandlerResult {
  operation: LspOperation;
  result: string;
  filePath: string;
  resultCount?: number;
  fileCount?: number;
}

/**
 * Execute an LSP operation for the given file and input.
 *
 * This is the main entry point called from localTools.ts dispatch.
 * It manages the full lifecycle:
 *   1. Validate input
 *   2. Read the file (if not already open on the server)
 *   3. Ensure the LSP server is running
 *   4. Send the operation request
 *   5. Format and return the result
 */
export async function handleLspTool(
  input: LspToolInput,
): Promise<ToolResult> {
  // ── Validate input ──────────────────────────────────────────────────────
  const validationError = validateInput(input);
  if (validationError) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[LSP_ERROR] ${validationError}`,
    };
  }

  const absolutePath = input.filePath;
  const cwd = process.cwd();
  const manager = getManager();

  try {
    // ── Map operation to method + params ──────────────────────────────────
    const { method, params } = getMethodAndParams(input, absolutePath);

    // ── Read file and open on server (if not already open) ────────────────
    if (!manager.isFileOpen(absolutePath)) {
      try {
        const handle = await open(absolutePath, 'r');
        try {
          const stats = await handle.stat();
          if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
            return {
              exit_code: 1,
              stdout: '',
              stderr: `[LSP_ERROR] File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit).`,
            };
          }
          const content = await handle.readFile({ encoding: 'utf-8' });
          await manager.openFile(absolutePath, content);
        } finally {
          await handle.close();
        }
      } catch (error) {
        return {
          exit_code: 1,
          stdout: '',
          stderr: `[LSP_ERROR] Cannot read file: ${absolutePath}. ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // ── For incomingCalls/outgoingCalls, two-step process ────────────────
    if (input.operation === 'incomingCalls' || input.operation === 'outgoingCalls') {
      const prepareResult = await manager.sendRequest<CallHierarchyItem[]>(
        absolutePath,
        'textDocument/prepareCallHierarchy',
        params,
      );

      if (!prepareResult || prepareResult.length === 0) {
        return {
          exit_code: 0,
          stdout: 'No call hierarchy item found at this position.',
          stderr: '',
        };
      }

      const callMethod = input.operation === 'incomingCalls'
        ? 'callHierarchy/incomingCalls'
        : 'callHierarchy/outgoingCalls';

      const callsResult = await manager.sendRequest(
        absolutePath,
        callMethod,
        { item: prepareResult[0] },
      );

      const { formatted, resultCount, fileCount } = formatResult(
        input.operation,
        callsResult,
        cwd,
      );

      const output: LspHandlerResult = {
        operation: input.operation,
        result: formatted,
        filePath: input.filePath,
        resultCount,
        fileCount,
      };

      return {
        exit_code: 0,
        stdout: JSON.stringify(output, null, 2),
        stderr: '',
      };
    }

    // ── Standard single-step operations ───────────────────────────────────
    const result = await manager.sendRequest(absolutePath, method, params);

    if (result === undefined) {
      const ext = extname(absolutePath);
      return {
        exit_code: 0,
        stdout: JSON.stringify(
          {
            operation: input.operation,
            result: `No LSP server available for file type: ${ext}`,
            filePath: input.filePath,
          } satisfies LspHandlerResult,
          null,
          2,
        ),
        stderr: '',
      };
    }

    const { formatted, resultCount, fileCount } = formatResult(
      input.operation,
      result,
      cwd,
    );

    const output: LspHandlerResult = {
      operation: input.operation,
      result: formatted,
      filePath: input.filePath,
      resultCount,
      fileCount,
    };

    return {
      exit_code: 0,
      stdout: JSON.stringify(output, null, 2),
      stderr: '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[LSP_ERROR] ${input.operation} on ${input.filePath} failed: ${message}`,
    };
  }
}

// ─── LocalTools Integration ──────────────────────────────────────────────────

/**
 * Build the handler for the 'lsp' executor tool.
 * Accepts a ToolCallRequest (which wraps LSP input) and returns ToolResult.
 */
export function buildLspToolHandler(): (
  req: ToolCallRequest,
) => Promise<ToolResult> {
  return async (req: ToolCallRequest) => {
    const input = LspToolInputSchema.parse(req);
    return handleLspTool(input);
  };
}

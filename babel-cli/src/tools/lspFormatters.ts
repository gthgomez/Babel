/**
 * LSP Response Formatters.
 *
 * Transforms raw LSP responses into human-readable strings for model consumption.
 * Follows the formatting patterns from the competitor reference (Claude Code).
 */

import { relative } from 'node:path';

import type {
  Location,
  Hover,
  DocumentSymbol,
  SymbolInformation,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  MarkupContent,
  MarkedString,
  LocationLink,
} from '../services/lsp/types.js';
import { SymbolKind } from '../services/lsp/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a URI to a human-readable path (relative if possible). */
function formatUri(uri: string, cwd?: string): string {
  let filePath = uri.replace(/^file:\/\//, '');
  // Strip leading slash for Windows drive-letter paths (file:///C:/path → C:/path)
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // Use un-decoded path if malformed
  }
  if (cwd) {
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/');
    if (relativePath.length < filePath.length && !relativePath.startsWith('../')) {
      return relativePath;
    }
  }
  return filePath.replaceAll('\\', '/');
}

/** Format a Location as `file:line:character`. */
function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd);
  const line = location.range.start.line + 1; // Convert to 1-based
  const character = location.range.start.character + 1;
  return `${filePath}:${line}:${character}`;
}

/** Convert LocationLink to Location. */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  };
}

/** Check if an item is a LocationLink. */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item;
}

/** SymbolKind number → readable string. */
function symbolKindToString(kind: SymbolKind): string {
  const kinds: Record<number, string> = {
    [SymbolKind.File]: 'File',
    [SymbolKind.Module]: 'Module',
    [SymbolKind.Namespace]: 'Namespace',
    [SymbolKind.Package]: 'Package',
    [SymbolKind.Class]: 'Class',
    [SymbolKind.Method]: 'Method',
    [SymbolKind.Property]: 'Property',
    [SymbolKind.Field]: 'Field',
    [SymbolKind.Constructor]: 'Constructor',
    [SymbolKind.Enum]: 'Enum',
    [SymbolKind.Interface]: 'Interface',
    [SymbolKind.Function]: 'Function',
    [SymbolKind.Variable]: 'Variable',
    [SymbolKind.Constant]: 'Constant',
    [SymbolKind.String]: 'String',
    [SymbolKind.Number]: 'Number',
    [SymbolKind.Boolean]: 'Boolean',
    [SymbolKind.Array]: 'Array',
    [SymbolKind.Object]: 'Object',
    [SymbolKind.Key]: 'Key',
    [SymbolKind.Null]: 'Null',
    [SymbolKind.EnumMember]: 'EnumMember',
    [SymbolKind.Struct]: 'Struct',
    [SymbolKind.Event]: 'Event',
    [SymbolKind.Operator]: 'Operator',
    [SymbolKind.TypeParameter]: 'TypeParameter',
  };
  return kinds[kind] ?? 'Unknown';
}

/** Group items by file URI. */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string,
): Map<string, T[]> {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const uri = 'uri' in item ? item.uri : item.location.uri;
    const filePath = formatUri(uri, cwd);
    const existing = byFile.get(filePath);
    if (existing) {
      existing.push(item);
    } else {
      byFile.set(filePath, [item]);
    }
  }
  return byFile;
}

// ─── Export: Go To Definition ────────────────────────────────────────────────

export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return 'No definition found.';
  }

  const results = Array.isArray(result) ? result : [result];
  const locations: Location[] = results.map((item) =>
    isLocationLink(item) ? locationLinkToLocation(item) : item,
  ).filter((loc) => loc && loc.uri);

  if (locations.length === 0) {
    return 'No definition found.';
  }

  if (locations.length === 1) {
    return `Defined at ${formatLocation(locations[0]!, cwd)}`;
  }

  const lines = locations.map((loc) => `  ${formatLocation(loc, cwd)}`);
  return `Found ${locations.length} definitions:\n${lines.join('\n')}`;
}

// ─── Export: Find References ─────────────────────────────────────────────────

export function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No references found.';
  }

  const validLocations = result.filter((loc) => loc && loc.uri);

  if (validLocations.length === 0) {
    return 'No references found.';
  }

  if (validLocations.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(validLocations[0]!, cwd)}`;
  }

  const byFile = groupByFile(validLocations, cwd);
  const lines: string[] = [
    `Found ${validLocations.length} references across ${byFile.size} files:`,
  ];

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const loc of locations) {
      const line = loc.range.start.line + 1;
      const character = loc.range.start.character + 1;
      lines.push(`  Line ${line}:${character}`);
    }
  }

  return lines.join('\n');
}

// ─── Export: Hover ───────────────────────────────────────────────────────────

function extractMarkupText(contents: MarkupContent | MarkedString | MarkedString[]): string {
  if (Array.isArray(contents)) {
    return contents.map((item) => {
      if (typeof item === 'string') return item;
      return item.value;
    }).join('\n\n');
  }
  if (typeof contents === 'string') return contents;
  if ('kind' in contents) return contents.value;
  return contents.value;
}

export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return 'No hover information available.';
  }

  const content = extractMarkupText(result.contents);

  if (result.range) {
    const line = result.range.start.line + 1;
    const character = result.range.start.character + 1;
    return `Hover info at ${line}:${character}:\n\n${content}`;
  }

  return content;
}

// ─── Export: Document Symbol ─────────────────────────────────────────────────

function formatDocumentSymbolNode(symbol: DocumentSymbol, indent = 0): string[] {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);
  const kind = symbolKindToString(symbol.kind);
  const symbolLine = symbol.range.start.line + 1;

  let line = `${prefix}${symbol.name} (${kind}) - Line ${symbolLine}`;
  if (symbol.detail) {
    line += ` ${symbol.detail}`;
  }
  lines.push(line);

  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1));
    }
  }

  return lines;
}

export function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in document.';
  }

  // Detect format: DocumentSymbol has 'range' directly, SymbolInformation has 'location'
  const first = result[0];
  const isSymbolInformation = first && 'location' in first;

  if (isSymbolInformation) {
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd);
  }

  const lines: string[] = ['Document symbols:'];
  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol));
  }

  return lines.join('\n');
}

// ─── Export: Workspace Symbol ────────────────────────────────────────────────

export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in workspace.';
  }

  const validSymbols = result.filter((sym) => sym && sym.location && sym.location.uri);

  if (validSymbols.length === 0) {
    return 'No symbols found in workspace.';
  }

  const lines: string[] = [
    `Found ${validSymbols.length} symbol(s) in workspace:`,
  ];

  const byFile = groupByFile(validSymbols, cwd);

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind);
      const line = symbol.location.range.start.line + 1;
      let symbolLine = `  ${symbol.name} (${kind}) - Line ${line}`;
      if (symbol.containerName) {
        symbolLine += ` in ${symbol.containerName}`;
      }
      lines.push(symbolLine);
    }
  }

  return lines.join('\n');
}

// ─── Export: Call Hierarchy ──────────────────────────────────────────────────

function formatCallHierarchyItem(item: CallHierarchyItem, cwd?: string): string {
  const filePath = formatUri(item.uri, cwd);
  const line = item.range.start.line + 1;
  const kind = symbolKindToString(item.kind);
  let result = `${item.name} (${kind}) - ${filePath}:${line}`;
  if (item.detail) {
    result += ` [${item.detail}]`;
  }
  return result;
}

export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No call hierarchy item found at this position.';
  }

  if (result.length === 1) {
    return `Call hierarchy item: ${formatCallHierarchyItem(result[0]!, cwd)}`;
  }

  const lines = [`Found ${result.length} call hierarchy items:`];
  for (const item of result) {
    lines.push(`  ${formatCallHierarchyItem(item, cwd)}`);
  }
  return lines.join('\n');
}

export function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No incoming calls found (nothing calls this function).';
  }

  const lines = [`Found ${result.length} incoming call(s):`];
  const byFile = new Map<string, CallHierarchyIncomingCall[]>();

  for (const call of result) {
    if (!call.from) continue;
    const filePath = formatUri(call.from.uri, cwd);
    const existing = byFile.get(filePath);
    if (existing) {
      existing.push(call);
    } else {
      byFile.set(filePath, [call]);
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const call of calls) {
      if (!call.from) continue;
      const kind = symbolKindToString(call.from.kind);
      const line = call.from.range.start.line + 1;
      let callLine = `  ${call.from.name} (${kind}) - Line ${line}`;
      if (call.fromRanges && call.fromRanges.length > 0) {
        const sites = call.fromRanges
          .map((r) => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ');
        callLine += ` [calls at: ${sites}]`;
      }
      lines.push(callLine);
    }
  }

  return lines.join('\n');
}

export function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No outgoing calls found (this function calls nothing).';
  }

  const lines = [`Found ${result.length} outgoing call(s):`];
  const byFile = new Map<string, CallHierarchyOutgoingCall[]>();

  for (const call of result) {
    if (!call.to) continue;
    const filePath = formatUri(call.to.uri, cwd);
    const existing = byFile.get(filePath);
    if (existing) {
      existing.push(call);
    } else {
      byFile.set(filePath, [call]);
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const call of calls) {
      if (!call.to) continue;
      const kind = symbolKindToString(call.to.kind);
      const line = call.to.range.start.line + 1;
      let callLine = `  ${call.to.name} (${kind}) - Line ${line}`;
      if (call.fromRanges && call.fromRanges.length > 0) {
        const sites = call.fromRanges
          .map((r) => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ');
        callLine += ` [called from: ${sites}]`;
      }
      lines.push(callLine);
    }
  }

  return lines.join('\n');
}

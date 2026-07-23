/**
 * toolRenderers.ts — Tool-specific grouped renderers (registry pattern)
 *
 * A registry-based system for rendering tool calls in the chat transcript.
 * Each tool type can have its own specialized renderer, with support for
 * grouping parallel tool calls into a single visual block.
 *
 * Integration note:
 * The waterfall renderer (src/ui/waterfall.ts) would call
 * `defaultToolRegistry.resolve(toolName)` to get the renderer for each tool
 * call, and use `ToolGroupRenderer` to batch parallel tool calls into a
 * single visual group.
 *
 * @module toolRenderers
 */

import {
  dim,
  muted,
  ghost,
  primary,
  accent,
  success,
  error as errColor,
  warning,
  info,
  bold,
  truncate,
  indentBlock,
} from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolRenderContext {
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: 'pending' | 'running' | 'complete' | 'error';
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface ToolRenderer {
  /** Unique tool name this renderer handles */
  toolName: string;
  /** Render the "running" state — shown while the tool executes */
  renderRunning(context: ToolRenderContext): string;
  /** Render the "complete" state — shown after the tool finishes */
  renderComplete(context: ToolRenderContext): string;
  /** Render the "error" state */
  renderError(context: ToolRenderContext): string;
  /** Whether to show the tool result inline (true for read ops, false for write ops) */
  showResult: boolean;
  /** Max lines of result to show inline */
  maxResultLines: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract a human-readable file path from toolInput. */
function extractPath(input: Record<string, unknown>): string {
  const path =
    typeof input.path === 'string'
      ? input.path
      : typeof input['filePath'] === 'string'
        ? input['filePath']
        : typeof input['target'] === 'string'
          ? input['target']
          : '';
  return path || '(unknown)';
}

/** Extract a human-readable command from toolInput. */
function extractCommand(input: Record<string, unknown>): string {
  return typeof input.command === 'string'
    ? input.command
    : typeof input['cmd'] === 'string'
      ? input['cmd']
      : typeof input['script'] === 'string'
        ? input['script']
        : '(unknown)';
}

/** Extract a search pattern from toolInput. */
function extractPattern(input: Record<string, unknown>): string {
  return typeof input.pattern === 'string'
    ? input.pattern
    : typeof input['query'] === 'string'
      ? input['query']
      : typeof input['q'] === 'string'
        ? input['q']
        : '(unknown)';
}

/** Extract a URL from toolInput. */
function extractUrl(input: Record<string, unknown>): string {
  return typeof input.url === 'string'
    ? input.url
    : typeof input['uri'] === 'string'
      ? input['uri']
      : typeof input['href'] === 'string'
        ? input['href']
        : '(unknown)';
}

/** Return a compact one-line summary of a result string. */
function summarizeResult(result: string | undefined, maxLen: number = 80): string {
  if (!result) return '';
  const cleaned = result.replace(/\s+/g, ' ').trim();
  return truncate(cleaned, maxLen);
}

/** Format a duration in milliseconds to a human-readable string. */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Extract line count from toolInput or result. */
function extractLineCount(context: ToolRenderContext): number | null {
  if (typeof context.toolInput.lineCount === 'number') return context.toolInput.lineCount;
  if (typeof context.toolInput['lines'] === 'number') return context.toolInput['lines'];
  if (context.result && typeof context.result === 'string') {
    const lines = context.result.split('\n');
    // Filter out trailing empty line from result strings that end with \n
    const nonEmpty = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    return nonEmpty.length;
  }
  return null;
}

/** Extract the last line count summary from a result string (e.g., "42 lines"). */
function extractResultLineCount(result: string | undefined): number | null {
  if (!result) return null;
  const match = result.match(/(\d+)\s+lines?/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** Extract a diff summary from toolInput (additions/deletions). */
function extractDiffInfo(
  input: Record<string, unknown>,
): { additions: number; deletions: number } | null {
  const additions =
    typeof input.additions === 'number'
      ? input.additions
      : typeof input['added'] === 'number'
        ? input['added']
        : undefined;
  const deletions =
    typeof input.deletions === 'number'
      ? input.deletions
      : typeof input['removed'] === 'number'
        ? input['removed']
        : undefined;
  if (additions !== undefined || deletions !== undefined) {
    return { additions: additions ?? 0, deletions: deletions ?? 0 };
  }
  return null;
}

/** Extract a content preview from toolInput. */
function extractContentPreview(input: Record<string, unknown>, maxLines: number = 3): string[] {
  const content =
    typeof input.content === 'string'
      ? input.content
      : typeof input['text'] === 'string'
        ? input['text']
        : undefined;
  if (!content) return [];
  const lines = content.split('\n');
  return lines.slice(0, maxLines);
}

// ── Built-in renderers ─────────────────────────────────────────────────────

/**
 * ReadFileRenderer — renders file read operations.
 * Shows filename + line count + preview snippet on complete.
 */
export class ReadFileRenderer implements ToolRenderer {
  readonly toolName: string = 'Read';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 5;

  renderRunning(context: ToolRenderContext): string {
    const path = extractPath(context.toolInput);
    return `${dim('Reading')} ${accent(path)}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const path = extractPath(context.toolInput);
    const lineCount =
      extractLineCount(context) ?? extractResultLineCount(context.result) ?? null;
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [success('Read'), accent(path)];
    if (lineCount !== null) parts.push(dim(`(${lineCount} lines)`));
    if (duration) parts.push(dim(duration));
    let output = parts.join(' ');

    // Append a preview snippet from the result
    if (context.result && this.showResult) {
      const previewLines = context.result.split('\n').slice(0, this.maxResultLines);
      const preview = previewLines.map((line) => `  ${dim('|')} ${line}`).join('\n');
      output += `\n${preview}`;
      if (previewLines.length < context.result.split('\n').length) {
        output += `\n  ${dim('|')} ${dim(`… ${context.result.split('\n').length - this.maxResultLines} more lines`)}`;
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const path = extractPath(context.toolInput);
    const msg = context.error ?? 'unknown error';
    return `${errColor('Failed')} ${accent(path)} ${dim(`— ${msg}`)}`;
  }
}

/**
 * WriteFileRenderer — renders file write operations.
 * Shows filename + mini diff summary on complete.
 */
export class WriteFileRenderer implements ToolRenderer {
  readonly toolName: string = 'Write';
  readonly showResult: boolean = false;
  readonly maxResultLines: number = 3;

  renderRunning(context: ToolRenderContext): string {
    const path = extractPath(context.toolInput);
    return `${dim('Writing')} ${accent(path)}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const path = extractPath(context.toolInput);
    const diff = extractDiffInfo(context.toolInput);
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [success('Written'), accent(path)];
    if (diff) {
      const addStr = diff.additions > 0 ? `+${diff.additions}` : '';
      const delStr = diff.deletions > 0 ? `−${diff.deletions}` : '';
      if (addStr || delStr) parts.push(dim(`(${addStr}${addStr && delStr ? '/' : ''}${delStr})`));
    }
    if (duration) parts.push(dim(duration));
    let output = parts.join(' ');

    // Show a brief content preview if showResult is true (for small writes)
    const previewLines = extractContentPreview(context.toolInput, this.maxResultLines);
    if (previewLines.length > 0) {
      output += `\n  ${dim('|')} ${previewLines.join(`\n  ${dim('|')} `)}`;
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const path = extractPath(context.toolInput);
    const msg = context.error ?? 'unknown error';
    return `${errColor('Failed')} ${accent(path)} ${dim(`— ${msg}`)}`;
  }
}

/**
 * BashRenderer — renders shell command execution.
 * Shows command + exit code + output summary.
 */
export class BashRenderer implements ToolRenderer {
  readonly toolName: string = 'Bash';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 3;

  renderRunning(context: ToolRenderContext): string {
    const cmd = extractCommand(context.toolInput);
    const display = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
    return `${dim('Running')} ${muted('$')} ${primary(display)}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const cmd = extractCommand(context.toolInput);
    const display = truncate(cmd, 60);
    const exitCode = this.extractExitCode(context);
    const duration = formatDuration(context.durationMs);
    const exitLabel = exitCode === 0 ? success('0') : warning(String(exitCode));
    const parts: string[] = [muted('$'), primary(display), dim('→'), exitLabel];
    if (duration) parts.push(dim(duration));
    let output = parts.join(' ');

    // Append output summary (truncated)
    if (context.result && this.showResult) {
      const lines = context.result.split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        const summaryLines = lines.slice(0, this.maxResultLines);
        const preview = summaryLines.map((line) => `  ${ghost('|')} ${truncate(line, 100)}`).join('\n');
        output += `\n${preview}`;
        if (lines.length > this.maxResultLines) {
          output += `\n  ${ghost(`… ${lines.length - this.maxResultLines} more lines`)}`;
        }
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const cmd = extractCommand(context.toolInput);
    const display = truncate(cmd, 60);
    const exitCode = this.extractExitCode(context);
    const msg = context.error ?? 'unknown error';
    const parts: string[] = [muted('$'), primary(display), errColor('✖')];
    if (exitCode !== null) parts.push(dim(`exit ${exitCode}`));
    parts.push(dim(`— ${msg}`));
    return parts.join(' ');
  }

  private extractExitCode(context: ToolRenderContext): number | null {
    if (context.toolInput.exitCode !== undefined) return Number(context.toolInput.exitCode);
    if (context.toolInput['exit_code'] !== undefined) return Number(context.toolInput['exit_code']);
    if (context.toolInput['code'] !== undefined) return Number(context.toolInput['code']);
    return null;
  }
}

/**
 * GrepRenderer — renders search/grep operations.
 * Shows pattern + match count + file list.
 */
export class GrepRenderer implements ToolRenderer {
  readonly toolName: string = 'Grep';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 5;

  renderRunning(context: ToolRenderContext): string {
    const pattern = extractPattern(context.toolInput);
    return `${dim('Searching for')} ${accent(pattern)}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const pattern = extractPattern(context.toolInput);
    const matchCount = this.extractMatchCount(context);
    const fileCount = this.extractFileCount(context);
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [success('Found')];

    if (matchCount !== null) {
      parts.push(accent(String(matchCount)));
      parts.push(dim(matchCount === 1 ? 'match' : 'matches'));
    }
    if (fileCount !== null) {
      parts.push(dim(`in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`));
    }
    parts.push(dim(`for "${pattern}"`));
    if (duration) parts.push(dim(duration));

    let output = parts.join(' ');

    // Extract file list from result
    if (context.result && this.showResult) {
      const files = this.extractFileList(context.result);
      if (files.length > 0) {
        const displayFiles = files.slice(0, this.maxResultLines);
        output += `\n${displayFiles.map((f) => `  ${ghost('└')} ${dim(f)}`).join('\n')}`;
        if (files.length > this.maxResultLines) {
          output += `\n  ${ghost(`… ${files.length - this.maxResultLines} more files`)}`;
        }
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const pattern = extractPattern(context.toolInput);
    const msg = context.error ?? 'unknown error';
    return `${errColor('Search failed')} ${dim(`for "${pattern}" — ${msg}`)}`;
  }

  private extractMatchCount(context: ToolRenderContext): number | null {
    if (typeof context.toolInput.matchCount === 'number') return context.toolInput.matchCount;
    if (typeof context.toolInput['match_count'] === 'number') return context.toolInput['match_count'];
    if (context.result) {
      const match = context.result.match(/(\d+)\s+matches?/);
      if (match) return Number.parseInt(match[1]!, 10);
    }
    return null;
  }

  private extractFileCount(context: ToolRenderContext): number | null {
    if (typeof context.toolInput.fileCount === 'number') return context.toolInput.fileCount;
    if (typeof context.toolInput['file_count'] === 'number') return context.toolInput['file_count'];
    if (context.result) {
      const match = context.result.match(/in\s+(\d+)\s+files?/);
      if (match) return Number.parseInt(match[1]!, 10);
    }
    return null;
  }

  private extractFileList(result: string): string[] {
    const lines = result.split('\n');
    return lines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('Search') && !l.startsWith('Found') && !l.includes('matches'))
      .slice(0, 20);
  }
}

/**
 * WebFetchRenderer — renders URL fetch operations.
 * Shows URL + status code + content length.
 */
export class WebFetchRenderer implements ToolRenderer {
  readonly toolName: string = 'WebFetch';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 3;

  renderRunning(context: ToolRenderContext): string {
    const url = extractUrl(context.toolInput);
    const display = url.length > 64 ? `${url.slice(0, 61)}...` : url;
    return `${dim('Fetching')} ${accent(display)}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const url = extractUrl(context.toolInput);
    const display = truncate(url, 64);
    const statusCode = this.extractStatusCode(context);
    const contentLength = this.extractContentLength(context);
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [success('Fetched'), accent(display)];

    if (statusCode !== null) {
      const codeStr = statusCode >= 200 && statusCode < 300 ? success(String(statusCode)) : warning(String(statusCode));
      parts.push(dim('→'), codeStr);
    }
    if (contentLength !== null) {
      parts.push(dim(`(${formatBytes(contentLength)})`));
    }
    if (duration) parts.push(dim(duration));

    let output = parts.join(' ');

    // Show a snippet from the fetched content
    if (context.result && this.showResult) {
      const lines = context.result.split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        const snippet = lines.slice(0, this.maxResultLines);
        const preview = snippet.map((line) => `  ${ghost('|')} ${truncate(line, 100)}`).join('\n');
        output += `\n${preview}`;
        if (lines.length > this.maxResultLines) {
          output += `\n  ${ghost(`… ${lines.length - this.maxResultLines} more lines`)}`;
        }
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const url = extractUrl(context.toolInput);
    const display = truncate(url, 64);
    const msg = context.error ?? 'unknown error';
    return `${errColor('Failed to fetch')} ${accent(display)} ${dim(`— ${msg}`)}`;
  }

  private extractStatusCode(context: ToolRenderContext): number | null {
    if (typeof context.toolInput.statusCode === 'number') return context.toolInput.statusCode;
    if (typeof context.toolInput['status_code'] === 'number') return context.toolInput['status_code'];
    if (typeof context.toolInput['status'] === 'number') return context.toolInput['status'];
    if (context.result) {
      const match = context.result.match(/status\s*:?\s*(\d{3})/i);
      if (match) return Number.parseInt(match[1]!, 10);
    }
    return null;
  }

  private extractContentLength(context: ToolRenderContext): number | null {
    if (typeof context.toolInput.contentLength === 'number') return context.toolInput.contentLength;
    if (typeof context.toolInput['content_length'] === 'number') return context.toolInput['content_length'];
    if (typeof context.toolInput['size'] === 'number') return context.toolInput['size'];
    if (typeof context.toolInput['bytes'] === 'number') return context.toolInput['bytes'];
    if (context.result) return context.result.length;
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * WebSearchRenderer — renders web search operations.
 * Shows query + result count.
 */
export class WebSearchRenderer implements ToolRenderer {
  readonly toolName: string = 'WebSearch';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 5;

  renderRunning(context: ToolRenderContext): string {
    const query = extractPattern(context.toolInput);
    return `${dim('Searching for')} ${accent(`"${query}"`)}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const query = extractPattern(context.toolInput);
    const resultCount = this.extractResultCount(context);
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [success('Found')];

    if (resultCount !== null) {
      parts.push(accent(String(resultCount)));
      parts.push(dim(resultCount === 1 ? 'result' : 'results'));
    }
    parts.push(dim(`for "${query}"`));
    if (duration) parts.push(dim(duration));

    let output = parts.join(' ');

    // Show first result titles
    if (context.result && this.showResult) {
      const lines = context.result.split('\n').filter((l) => l.trim());
      const displayLines = lines.slice(0, this.maxResultLines);
      if (displayLines.length > 0) {
        output += `\n${displayLines.map((l) => `  ${ghost('•')} ${truncate(l, 80)}`).join('\n')}`;
        if (lines.length > this.maxResultLines) {
          output += `\n  ${ghost(`… ${lines.length - this.maxResultLines} more results`)}`;
        }
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const query = extractPattern(context.toolInput);
    const msg = context.error ?? 'unknown error';
    return `${errColor('Search failed')} ${dim(`for "${query}" — ${msg}`)}`;
  }

  private extractResultCount(context: ToolRenderContext): number | null {
    if (typeof context.toolInput.resultCount === 'number') return context.toolInput.resultCount;
    if (typeof context.toolInput['result_count'] === 'number') return context.toolInput['result_count'];
    if (typeof context.toolInput['count'] === 'number') return context.toolInput['count'];
    if (context.result) {
      const match = context.result.match(/(\d+)\s+results?/);
      if (match) return Number.parseInt(match[1]!, 10);
    }
    return null;
  }
}

/**
 * SubAgentRenderer — renders subagent/spawned agent operations.
 * Shows agent name + task summary + progress.
 */
export class SubAgentRenderer implements ToolRenderer {
  readonly toolName: string = 'SubAgent';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 5;

  renderRunning(context: ToolRenderContext): string {
    const agentName = this.extractAgentName(context);
    const task = this.extractTask(context);
    const parts: string[] = [dim('Agent'), accent(agentName)];
    if (task) parts.push(dim(`— ${truncate(task, 60)}`));
    parts.push(dim('...'));
    return parts.join(' ');
  }

  renderComplete(context: ToolRenderContext): string {
    const agentName = this.extractAgentName(context);
    const task = this.extractTask(context);
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [success('Agent'), accent(agentName), success('✓')];
    if (task) parts.push(dim(truncate(task, 60)));
    if (duration) parts.push(dim(duration));

    let output = parts.join(' ');

    // Show agent output summary
    if (context.result && this.showResult) {
      const lines = context.result.split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        const displayLines = lines.slice(0, this.maxResultLines);
        output += `\n${displayLines.map((l) => `  ${ghost('|')} ${truncate(l, 90)}`).join('\n')}`;
        if (lines.length > this.maxResultLines) {
          output += `\n  ${ghost(`… ${lines.length - this.maxResultLines} more lines`)}`;
        }
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const agentName = this.extractAgentName(context);
    const task = this.extractTask(context);
    const msg = context.error ?? 'unknown error';
    const parts: string[] = [errColor('Agent'), accent(agentName), errColor('✖')];
    if (task) parts.push(dim(truncate(task, 60)));
    parts.push(dim(`— ${msg}`));
    return parts.join(' ');
  }

  private extractAgentName(context: ToolRenderContext): string {
    return (
      (typeof context.toolInput.agentName === 'string'
        ? context.toolInput.agentName
        : typeof context.toolInput['agent'] === 'string'
          ? context.toolInput['agent']
          : typeof context.toolInput['name'] === 'string'
            ? context.toolInput['name']
            : undefined) ?? context.toolName
    );
  }

  private extractTask(context: ToolRenderContext): string {
    return (
      (typeof context.toolInput.task === 'string'
        ? context.toolInput.task
        : typeof context.toolInput['objective'] === 'string'
          ? context.toolInput['objective']
          : typeof context.toolInput['description'] === 'string'
            ? context.toolInput['description']
            : undefined) ?? ''
    );
  }
}

/**
 * GenericToolRenderer — fallback renderer for any tool.
 * Shows tool name + raw JSON input summary.
 */
export class GenericToolRenderer implements ToolRenderer {
  readonly toolName: string = '*';
  readonly showResult: boolean = true;
  readonly maxResultLines: number = 3;

  renderRunning(context: ToolRenderContext): string {
    const inputPreview = this.previewInput(context.toolInput);
    return `${dim('Tool:')} ${accent(context.toolName)}${inputPreview ? ` ${dim(inputPreview)}` : ''}${dim('...')}`;
  }

  renderComplete(context: ToolRenderContext): string {
    const duration = formatDuration(context.durationMs);
    const parts: string[] = [accent(context.toolName), success('✓')];
    if (duration) parts.push(dim(duration));

    let output = parts.join(' ');

    if (context.result && this.showResult) {
      const summary = summarizeResult(context.result, 120);
      if (summary) {
        output += `\n  ${ghost(summary)}`;
      }
    }
    return output;
  }

  renderError(context: ToolRenderContext): string {
    const msg = context.error ?? 'unknown error';
    return `${accent(context.toolName)} ${errColor('✖')} ${dim(`— ${msg}`)}`;
  }

  private previewInput(input: Record<string, unknown>, maxLen: number = 40): string {
    const keys = Object.keys(input);
    if (keys.length === 0) return '';
    const preview = keys.slice(0, 3).join(', ');
    const rest = keys.length > 3 ? `, +${keys.length - 3} more` : '';
    return truncate(`${preview}${rest}`, maxLen);
  }
}

// ── ToolGroupRenderer ──────────────────────────────────────────────────────

export type GroupStatus = 'running' | 'complete' | 'partial';

export interface ToolGroupState {
  tools: ToolRenderContext[];
  status: GroupStatus;
}

/**
 * ToolGroupRenderer — groups multiple parallel tool calls into a single
 * visual block (like Claude Code's grouped parallel tools).
 *
 * Usage:
 *   const group = new ToolGroupRenderer();
 *   group.addTool(context1);
 *   group.addTool(context2);
 *   // ... later, as each tool completes:
 *   group.updateTool(toolId, { status: 'complete', result: '...' });
 *   const rendered = group.render();
 */
export class ToolGroupRenderer {
  private tools: Map<string, ToolRenderContext> = new Map();
  private finalized: boolean = false;
  private registry: ToolRendererRegistry;

  constructor(registry?: ToolRendererRegistry) {
    this.registry = registry ?? defaultToolRegistry;
  }

  /** Add a tool to the current group */
  addTool(context: ToolRenderContext): void {
    this.tools.set(context.toolId, { ...context });
  }

  /** Get the rendered group block */
  render(): string {
    const toolList = Array.from(this.tools.values());
    if (toolList.length === 0) return '';

    const status = this.getStatus();
    const registry = this.registry;
    const lines: string[] = [];

    // Group header
    const totalCount = toolList.length;
    const completedCount = toolList.filter(
      (t) => t.status === 'complete' || t.status === 'error',
    ).length;
    const statusIcon = this.statusIcon(status);
    const header = `${ghost('│')} ${statusIcon} ${dim(`${completedCount}/${totalCount} parallel tools`)}`;
    lines.push(header);

    // Each tool rendered compactly
    for (const tool of toolList) {
      const renderer = registry.resolve(tool.toolName);
      const line = this.renderToolCompact(tool, renderer);
      lines.push(`  ${line}`);
    }

    return lines.join('\n');
  }

  /** Whether any tools in the group are still running or pending */
  hasPending(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.status === 'pending' || tool.status === 'running') return true;
    }
    return false;
  }

  /** Mark a tool as complete/error */
  updateTool(toolId: string, update: Partial<ToolRenderContext>): void {
    const existing = this.tools.get(toolId);
    if (!existing) return;
    Object.assign(existing, update);
  }

  /** Finalize the group — marks the group as complete and renders all tools in final state */
  finalize(): void {
    this.finalized = true;
  }

  /** Number of tools in the group */
  get size(): number {
    return this.tools.size;
  }

  /** The current group status */
  getStatus(): GroupStatus {
    if (this.finalized) return 'complete';
    for (const tool of this.tools.values()) {
      if (tool.status === 'running' || tool.status === 'pending') return 'running';
    }
    // All tools have terminal status
    return 'complete';
  }

  private statusIcon(status: GroupStatus): string {
    switch (status) {
      case 'complete':
        return success('✓');
      case 'partial':
        return warning('⚠');
      case 'running':
      default:
        return dim('○');
    }
  }

  private renderToolCompact(tool: ToolRenderContext, renderer: ToolRenderer): string {
    switch (tool.status) {
      case 'running':
        return renderer.renderRunning(tool);
      case 'complete':
        return renderer.renderComplete(tool);
      case 'error':
        return renderer.renderError(tool);
      case 'pending':
      default:
        return dim(`⏳ ${tool.toolName}${tool.toolId ? ` [${tool.toolId}]` : ''}`);
    }
  }
}

// ── ToolRendererRegistry ───────────────────────────────────────────────────

/**
 * ToolRendererRegistry — registry pattern for registering and looking up
 * tool renderers. Falls back to GenericToolRenderer when no specific
 * renderer is registered for a tool name.
 */
export class ToolRendererRegistry {
  private renderers: Map<string, ToolRenderer> = new Map();
  private generic?: ToolRenderer;

  /** Register a renderer for a specific tool name. */
  register(renderer: ToolRenderer): void {
    const key = renderer.toolName.toLowerCase();
    this.renderers.set(key, renderer);
    if (key === '*') {
      this.generic = renderer;
    }
  }

  /** Get a renderer by exact tool name. */
  get(toolName: string): ToolRenderer | undefined {
    return this.renderers.get(toolName.toLowerCase());
  }

  /** Check if a renderer is registered for the given tool name. */
  has(toolName: string): boolean {
    return this.renderers.has(toolName.toLowerCase());
  }

  /**
   * Get the best matching renderer for the given tool name.
   *
   * Resolution order:
   * 1. Exact match (case-insensitive)
   * 2. Prefix match — e.g., "Read" matches "file_read", "ReadFile"
   * 3. Fuzzy match — check if any registered tool name is contained in the
   *    given toolName, or vice versa
   * 4. Fall back to GenericToolRenderer (registered as '*')
   */
  resolve(toolName: string): ToolRenderer {
    const normalized = toolName.toLowerCase();

    // 1. Exact match
    const exact = this.renderers.get(normalized);
    if (exact) return exact;

    // 2. Prefix match — check if the normalized toolName starts with or
    //    contains a registered key (e.g., "file_read" contains "read")
    for (const [key, renderer] of this.renderers) {
      if (key === '*') continue;
      if (normalized.includes(key) || key.includes(normalized)) return renderer;
    }

    // 3. Check known aliases
    const aliasMatch = this.resolveAlias(normalized);
    if (aliasMatch) return aliasMatch;

    // 4. Fallback to generic
    return this.generic ?? this.getGenericFallback();
  }

  private resolveAlias(normalized: string): ToolRenderer | undefined {
    // Map of common tool name variants to canonical keys
    const aliasMap: Record<string, string[]> = {
      read: ['file_read', 'read_file', 'read'],
      write: ['file_write', 'write_file', 'edit_file', 'write'],
      bash: ['shell_exec', 'shell', 'bash', 'run', 'exec', 'execute'],
      grep: ['grep_search', 'search', 'find', 'grep'],
      webfetch: ['web_fetch', 'fetch_url', 'fetch', 'http_get', 'http'],
      websearch: ['web_search', 'search_web', 'search'],
      subagent: ['agent', 'sub_agent', 'spawn_agent', 'delegate'],
    };

    for (const [canonicalKey, aliases] of Object.entries(aliasMap)) {
      if (aliases.includes(normalized)) {
        const renderer = this.renderers.get(canonicalKey);
        if (renderer) return renderer;
      }
    }
    return undefined;
  }

  private getGenericFallback(): ToolRenderer {
    const generic = new GenericToolRenderer();
    this.renderers.set('*', generic);
    this.generic = generic;
    return generic;
  }
}

// ── Default registry ───────────────────────────────────────────────────────

/**
 * Default registry with all built-in renderers registered.
 */
export const defaultToolRegistry: ToolRendererRegistry = (() => {
  const registry = new ToolRendererRegistry();
  registry.register(new ReadFileRenderer());
  registry.register(new WriteFileRenderer());
  registry.register(new BashRenderer());
  registry.register(new GrepRenderer());
  registry.register(new WebFetchRenderer());
  registry.register(new WebSearchRenderer());
  registry.register(new SubAgentRenderer());
  registry.register(new GenericToolRenderer());
  return registry;
})();

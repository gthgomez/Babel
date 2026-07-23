/**
 * toolPermissions.ts — Per-tool permission UI renderers and registry.
 *
 * Provides a registry pattern where each tool type can register a specialized
 * renderer that gives users more context about what each tool will do before
 * they approve or deny the action.
 *
 * Integration points (planned — not wired yet):
 *   - src/agent/chatApproval.ts  →  Use defaultPermissionRegistry to render
 *                                    tool-specific permission dialogs instead of
 *                                    the generic PermissionDialog.
 *   - src/ui/dialog.ts           →  ToolPermissionRenderer output can feed into
 *                                    PermissionDialog.buildContent() for richer
 *                                    per-tool confirmation UIs.
 *
 * @module toolPermissions
 */

import {
  dim,
  muted,
  ghost,
  accent,
  warning,
  error,
  info,
  success,
  bold,
} from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type PermissionSeverity = 'safe' | 'normal' | 'dangerous';

export interface ToolPermissionContext {
  /** Canonical tool name (e.g. "run_command", "read_file"). */
  toolName: string;
  /** Raw input argument object for this tool invocation. */
  toolInput: Record<string, unknown>;
  /** Human-readable display name (e.g. "Shell Command", "Read File"). */
  toolDisplayName: string;
}

export interface ToolPermissionRenderer {
  /** The tool name this renderer handles (e.g. "run_command"). Use "*" for generic fallback. */
  toolName: string;
  /** Default severity level for this tool type. */
  severity: PermissionSeverity;
  /**
   * Render a detailed description of what the tool will do.
   * Returns an ANSI-styled multi-line string for display in permission dialogs.
   */
  render(context: ToolPermissionContext): string;
  /**
   * Render the confirmation prompt text.
   * For 'safe' operations this should return an empty string (auto-approve).
   * For 'dangerous' operations this should require explicit typed confirmation.
   */
  renderConfirmationPrompt(context: ToolPermissionContext): string;
}

// ── Destructive pattern detection ───────────────────────────────────────────────

/** Regex patterns that indicate potentially destructive shell commands. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  /\bmknod\b/,
  /:\(\)\s*\{/,
];

/**
 * Check a command string for destructive patterns.
 * Returns the matched pattern source, or null if none found.
 */
export function hasDestructivePattern(command: string): string | null {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.source;
    }
  }
  return null;
}

// ── Severity classification ─────────────────────────────────────────────────────

/**
 * Classify a tool call by risk level based on tool name and input content.
 *
 * Classification rules:
 *   - safe:   read-only operations (read_file, list_dir, grep, glob, search, git_context)
 *   - normal: write/patch/network tools without destructive patterns
 *   - dangerous: delete-family tools, or run_command containing sudo/rm/chmod etc.
 */
export function getPermissionSeverity(
  toolName: string,
  input: Record<string, unknown>,
): PermissionSeverity {
  const normalizedName = toolName.toLowerCase();

  // Safe: read-only operations
  const safeTools = new Set([
    'read_file',
    'list_dir',
    'list_files',
    'grep',
    'glob',
    'search',
    'semantic_search',
    'git_context',
    'mcp_tool_search',
  ]);
  if (safeTools.has(normalizedName)) {
    return 'safe';
  }

  // Dangerous: explicit delete/destructive operations
  const dangerousTools = new Set([
    'delete_file',
    'delete_files',
    'delete',
    'destroy',
    'remove',
  ]);
  if (dangerousTools.has(normalizedName)) {
    return 'dangerous';
  }

  // Dangerous: run_command / execute_command with destructive patterns
  if (normalizedName === 'run_command' || normalizedName === 'execute_command' || normalizedName === 'shell_exec') {
    const command =
      typeof input['command'] === 'string'
        ? input['command']
        : typeof input['cmd'] === 'string'
          ? input['cmd']
          : '';
    if (hasDestructivePattern(command)) {
      return 'dangerous';
    }
  }

  // Normal: everything else (write_file, apply_patch, web_fetch, web_search, etc.)
  return 'normal';
}

// ── ToolPermissionRegistry ──────────────────────────────────────────────────────

export class ToolPermissionRegistry {
  private renderers = new Map<string, ToolPermissionRenderer>();
  private fallback: ToolPermissionRenderer | null = null;

  /**
   * Register a tool renderer. If the toolName is '*', it becomes the generic
   * fallback renderer for unregistered tools.
   */
  register(renderer: ToolPermissionRenderer): void {
    if (renderer.toolName === '*') {
      this.fallback = renderer;
    } else {
      this.renderers.set(renderer.toolName, renderer);
    }
  }

  /**
   * Get the renderer for a specific tool name.
   * Falls back to the generic renderer if one is registered.
   * Returns undefined if no matching renderer is found.
   */
  get(toolName: string): ToolPermissionRenderer | undefined {
    return this.renderers.get(toolName) ?? this.fallback ?? undefined;
  }

  /** Check if a specific tool has a dedicated renderer (ignores fallback). */
  has(toolName: string): boolean {
    return this.renderers.has(toolName);
  }

  /** Return all registered dedicated tool names (excludes fallback). */
  getRegisteredTools(): string[] {
    return [...this.renderers.keys()];
  }
}

// ── Factory: Bash / Shell Command ───────────────────────────────────────────────

export function createBashPermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: 'run_command',
    severity: 'normal',
    render(context: ToolPermissionContext): string {
      const command =
        typeof context.toolInput['command'] === 'string'
          ? context.toolInput['command']
          : typeof context.toolInput['cmd'] === 'string'
            ? context.toolInput['cmd']
            : '';
      const cwd =
        typeof context.toolInput['cwd'] === 'string'
          ? context.toolInput['cwd']
          : typeof context.toolInput['working_directory'] === 'string'
            ? context.toolInput['working_directory']
            : undefined;
      const destructive = hasDestructivePattern(command);

      const lines: string[] = [];
      lines.push(bold('Shell Command'));
      lines.push('');
      lines.push(`  ${warning('$')} ${command}`);
      if (cwd) {
        lines.push(`  ${dim('Directory:')} ${info(cwd)}`);
      }
      lines.push(`  ${dim('Lines:')} ${command.split('\n').length}`);
      if (destructive) {
        lines.push(`  ${error('⚠')} Destructive pattern detected: ${warning(destructive)}`);
      }

      // Show snippet for multi-line commands
      if (command.includes('\n')) {
        lines.push('');
        const cmdLines = command.split('\n');
        const preview = cmdLines.slice(0, 5);
        lines.push(muted('  ── Preview ──'));
        for (const l of preview) {
          lines.push(ghost(`  ${l}`));
        }
        if (cmdLines.length > 5) {
          lines.push(ghost(`  ... ${cmdLines.length - 5} more lines`));
        }
      }

      return lines.join('\n');
    },
    renderConfirmationPrompt(context: ToolPermissionContext): string {
      const command =
        typeof context.toolInput['command'] === 'string'
          ? context.toolInput['command']
          : typeof context.toolInput['cmd'] === 'string'
            ? context.toolInput['cmd']
            : '';
      if (hasDestructivePattern(command)) {
        return bold(error('This command is potentially destructive. Type "yes" to confirm: '));
      }
      return 'Allow this shell command? [y/N]: ';
    },
  };
}

// ── Factory: File Read ──────────────────────────────────────────────────────────

export function createFileReadPermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: 'read_file',
    severity: 'safe',
    render(context: ToolPermissionContext): string {
      const path =
        typeof context.toolInput['path'] === 'string'
          ? context.toolInput['path']
          : typeof context.toolInput['file'] === 'string'
            ? context.toolInput['file']
            : typeof context.toolInput['filepath'] === 'string'
              ? context.toolInput['filepath']
              : '';

      const lines: string[] = [];
      lines.push(bold('Read File'));
      lines.push('');
      lines.push(`  ${dim('Path:')} ${info(path)}`);

      // If the tool input includes content (e.g. from a preview), show size
      if (typeof context.toolInput['content'] === 'string') {
        const content = context.toolInput['content'] as string;
        const fileLines = content.split('\n').length;
        const byteSize = Buffer.byteLength(content, 'utf8');
        const sizeLabel = byteSize < 1024
          ? `${byteSize} B`
          : `${(byteSize / 1024).toFixed(1)} KB`;
        lines.push(`  ${dim('Size:')} ${accent(sizeLabel)}`);
        lines.push(`  ${dim('Lines:')} ${fileLines}`);

        // Show a preview
        if (fileLines > 0) {
          lines.push('');
          const previewLines = content.split('\n').slice(0, 5);
          lines.push(muted('  ── Preview ──'));
          for (const l of previewLines) {
            lines.push(ghost(`  ${l}`));
          }
          if (fileLines > 5) {
            lines.push(ghost(`  ... ${fileLines - 5} more lines`));
          }
        }
      }

      return lines.join('\n');
    },
    renderConfirmationPrompt(_context: ToolPermissionContext): string {
      return ''; // Safe operations are auto-approved
    },
  };
}

// ── Factory: File Write / Edit ──────────────────────────────────────────────────

export function createFileWritePermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: 'write_file',
    severity: 'normal',
    render(context: ToolPermissionContext): string {
      const path =
        typeof context.toolInput['path'] === 'string'
          ? context.toolInput['path']
          : typeof context.toolInput['file'] === 'string'
            ? context.toolInput['file']
            : typeof context.toolInput['filepath'] === 'string'
              ? context.toolInput['filepath']
              : '';
      const content =
        typeof context.toolInput['content'] === 'string'
          ? context.toolInput['content']
          : typeof context.toolInput['body'] === 'string'
            ? context.toolInput['body']
            : '';
      const contentLines = content.split('\n');

      const lines: string[] = [];
      lines.push(bold(success('Write File')));
      lines.push('');
      lines.push(`  ${dim('Path:')} ${info(path)}`);
      lines.push(`  ${dim('Lines:')} ${contentLines.length}`);

      if (contentLines.length > 0 && contentLines[0] !== '') {
        lines.push('');
        const previewLines = contentLines.slice(0, 6);
        lines.push(muted('  ── Content Preview ──'));
        for (const l of previewLines) {
          lines.push(ghost(`  ${l}`));
        }
        if (contentLines.length > 6) {
          lines.push(ghost(`  ... ${contentLines.length - 6} more lines`));
        }
      }

      return lines.join('\n');
    },
    renderConfirmationPrompt(_context: ToolPermissionContext): string {
      return 'Allow writing this file? [y/N]: ';
    },
  };
}

// ── Factory: File Patch ─────────────────────────────────────────────────────────

export function createFilePatchPermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: 'apply_patch',
    severity: 'normal',
    render(context: ToolPermissionContext): string {
      const patch =
        typeof context.toolInput['patch'] === 'string'
          ? context.toolInput['patch']
          : '';
      const patchLines = patch.split('\n');
      // Count only actual change lines, excluding diff header lines (---, +++, @@)
      const added = patchLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const removed = patchLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

      const lines: string[] = [];
      lines.push(bold('Apply Patch'));
      lines.push('');
      lines.push(`  ${dim('Changes:')} ${success(`+${added}`)}/${error(`-${removed}`)} lines`);

      if (patchLines.length > 0 && patchLines[0] !== '') {
        lines.push('');
        lines.push(muted('  ── Diff Preview ──'));
        const preview = patchLines.slice(0, 8);
        for (const l of preview) {
          if (l.startsWith('+')) {
            lines.push(success(`  ${l}`));
          } else if (l.startsWith('-')) {
            lines.push(error(`  ${l}`));
          } else if (l.startsWith('@@')) {
            lines.push(info(`  ${l}`));
          } else {
            lines.push(ghost(`  ${l}`));
          }
        }
        if (patchLines.length > 8) {
          lines.push(ghost(`  ... ${patchLines.length - 8} more lines`));
        }
      }

      return lines.join('\n');
    },
    renderConfirmationPrompt(_context: ToolPermissionContext): string {
      return 'Allow applying this patch? [y/N]: ';
    },
  };
}

// ── Factory: Web Fetch ──────────────────────────────────────────────────────────

export function createWebFetchPermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: 'web_fetch',
    severity: 'normal',
    render(context: ToolPermissionContext): string {
      const url =
        typeof context.toolInput['url'] === 'string'
          ? context.toolInput['url']
          : typeof context.toolInput['uri'] === 'string'
            ? context.toolInput['uri']
            : '';

      let domain = '';
      try {
        domain = new URL(url).hostname;
      } catch {
        // Invalid URL — leave domain empty
      }

      const lines: string[] = [];
      lines.push(bold('Web Fetch'));
      lines.push('');
      lines.push(`  ${dim('URL:')} ${accent(url)}`);
      if (domain) {
        lines.push(`  ${dim('Domain:')} ${info(domain)}`);
      }

      return lines.join('\n');
    },
    renderConfirmationPrompt(_context: ToolPermissionContext): string {
      return 'Allow fetching this URL? [y/N]: ';
    },
  };
}

// ── Factory: Web Search ─────────────────────────────────────────────────────────

export function createWebSearchPermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: 'web_search',
    severity: 'normal',
    render(context: ToolPermissionContext): string {
      const query =
        typeof context.toolInput['query'] === 'string'
          ? context.toolInput['query']
          : typeof context.toolInput['q'] === 'string'
            ? context.toolInput['q']
            : typeof context.toolInput['text'] === 'string'
              ? context.toolInput['text']
              : '';

      const lines: string[] = [];
      lines.push(bold('Web Search'));
      lines.push('');
      lines.push(`  ${dim('Query:')} ${accent(query)}`);

      return lines.join('\n');
    },
    renderConfirmationPrompt(_context: ToolPermissionContext): string {
      return 'Allow this web search? [y/N]: ';
    },
  };
}

// ── Factory: Generic Fallback ────────────────────────────────────────────────────

export function createGenericPermissionRenderer(): ToolPermissionRenderer {
  return {
    toolName: '*',
    severity: 'normal',
    render(context: ToolPermissionContext): string {
      const lines: string[] = [];
      lines.push(bold(muted('Tool Call')));
      lines.push('');
      lines.push(`  ${dim('Tool:')} ${accent(context.toolDisplayName)}`);

      const json = JSON.stringify(context.toolInput, null, 2);
      lines.push(`  ${dim('Input:')}`);
      for (const line of json.split('\n')) {
        lines.push(ghost(`  ${line}`));
      }

      return lines.join('\n');
    },
    renderConfirmationPrompt(_context: ToolPermissionContext): string {
      return 'Allow this tool call? [y/N]: ';
    },
  };
}

// ── Default Registry ─────────────────────────────────────────────────────────────

/**
 * Pre-configured registry with all built-in tool renderers registered.
 *
 * Usage:
 *   import { defaultPermissionRegistry } from './toolPermissions.js';
 *   const renderer = defaultPermissionRegistry.get(toolName);
 *   if (renderer) {
 *     const output = renderer.render(context);
 *     const prompt = renderer.renderConfirmationPrompt(context);
 *   }
 */
export const defaultPermissionRegistry = new ToolPermissionRegistry();

const builtInRenderers: ToolPermissionRenderer[] = [
  createBashPermissionRenderer(),
  createFileReadPermissionRenderer(),
  createFileWritePermissionRenderer(),
  createFilePatchPermissionRenderer(),
  createWebFetchPermissionRenderer(),
  createWebSearchPermissionRenderer(),
  createGenericPermissionRenderer(),
];

for (const renderer of builtInRenderers) {
  defaultPermissionRegistry.register(renderer);
}

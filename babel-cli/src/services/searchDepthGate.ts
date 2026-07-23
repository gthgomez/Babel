// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchDepthState {
  /** Number of search/read operations performed since last mutation */
  searchesSinceMutation: number;
  /** Total search/read operations this session */
  totalSearches: number;
  /** Total mutations allowed this session */
  totalMutations: number;
  /** Whether the gate is currently active */
  active: boolean;
  /** Minimum searches required before next mutation */
  requiredSearches: number;
  /** Whether the last mutation was blocked */
  lastBlocked: boolean;
  /** Reason for last block (if any) */
  blockReason: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_REQUIRED_SEARCHES = 3;

/** Tools that count as "search/read" operations */
const SEARCH_READ_TOOLS = new Set([
  'grep',
  'glob',
  'semantic_search',
  'workspace_symbol_search',
  'workspace_map',
  'git_context',
  'file_read',
  'directory_list',
  'web_search',
  'web_fetch',
]);

/** Tools that are mutations (require depth before execution) */
const MUTATION_TOOLS = new Set(['file_write', 'shell_exec', 'test_run']);

/** Tools that are neutral (don't count either way) */
const NEUTRAL_TOOLS = new Set([
  'enter_plan_mode',
  'exit_plan_mode',
  'acquire_lock',
  'release_lock',
  'memory_store',
  'memory_query',
  'mcp_request',
  'mcp_resource_list',
  'mcp_resource_read',
  'mcp_prompt_list',
  'mcp_prompt_get',
  'mcp_tool_search',
  'plugin_tool',
  'audit_ui',
]);

// ─── SearchDepthGate ──────────────────────────────────────────────────────────

export class SearchDepthGate {
  private state: SearchDepthState;
  private requiredSearches: number;

  constructor(requiredSearches = DEFAULT_REQUIRED_SEARCHES) {
    this.requiredSearches = Math.max(1, requiredSearches);
    this.state = {
      searchesSinceMutation: 0,
      totalSearches: 0,
      totalMutations: 0,
      active: isGateEnabled(),
      requiredSearches: this.requiredSearches,
      lastBlocked: false,
      blockReason: null,
    };
  }

  /**
   * Check whether a tool call should be allowed.
   * Returns a block reason if the tool is blocked, or null if allowed.
   */
  checkBeforeCall(toolName: string): { allowed: boolean; reason?: string } {
    if (!this.state.active) return { allowed: true };

    // Neutral tools always allowed
    if (NEUTRAL_TOOLS.has(toolName)) return { allowed: true };

    // Search/read tools always allowed — they build depth
    if (SEARCH_READ_TOOLS.has(toolName)) return { allowed: true };

    // Mutation tools require depth
    if (MUTATION_TOOLS.has(toolName)) {
      if (this.state.searchesSinceMutation < this.requiredSearches) {
        const reason =
          `Search depth gate: ${this.state.searchesSinceMutation}/${this.requiredSearches} required searches before mutations. ` +
          `Run ${this.requiredSearches - this.state.searchesSinceMutation} more search/read operations (grep, glob, file_read, directory_list, etc.) first. ` +
          `Set BABEL_ENFORCE_SEARCH_GATE=false to disable this gate.`;
        this.state.lastBlocked = true;
        this.state.blockReason = reason;
        return { allowed: false, reason };
      }

      // Reset counter after mutation
      this.state.searchesSinceMutation = 0;
      this.state.totalMutations++;
      this.state.lastBlocked = false;
      this.state.blockReason = null;
      return { allowed: true };
    }

    // Unknown tools — allow (shouldn't happen in practice)
    return { allowed: true };
  }

  /**
   * Record a completed tool call to update depth counters.
   */
  recordCall(toolName: string, exitCode: number): void {
    if (!this.state.active) return;

    // Only count successful search/read operations
    if (SEARCH_READ_TOOLS.has(toolName) && exitCode === 0) {
      this.state.searchesSinceMutation++;
      this.state.totalSearches++;
    }
  }

  /**
   * Get current gate state for diagnostics.
   */
  getState(): SearchDepthState {
    return { ...this.state };
  }

  /**
   * Reset counters (e.g., for a new session).
   */
  reset(): void {
    this.state.searchesSinceMutation = 0;
    this.state.lastBlocked = false;
    this.state.blockReason = null;
  }

  /**
   * Override required depth at runtime.
   */
  setRequiredSearches(n: number): void {
    this.requiredSearches = Math.max(1, n);
    this.state.requiredSearches = this.requiredSearches;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isGateEnabled(): boolean {
  const env = process.env['BABEL_ENFORCE_SEARCH_GATE'];
  if (env === undefined || env === '') return false;
  return env.toLowerCase() === 'true' || env === '1' || env.toLowerCase() === 'yes';
}

// ─── Session singleton ────────────────────────────────────────────────────────

let sessionGate: SearchDepthGate | null = null;

export function getSessionGate(): SearchDepthGate {
  if (!sessionGate) {
    sessionGate = new SearchDepthGate();
  }
  return sessionGate;
}

export function resetSessionGate(): void {
  sessionGate = null;
}

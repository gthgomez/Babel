import type { ExecutionProfileName } from '../config/executionProfiles.js';
import type { AgentAction } from './actions.js';
import type { LiteSessionVerb } from './contracts.js';
import { emitAgentEvent } from './events.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type PermissionPreset =
  | 'read_only'
  | 'workspace_write'
  | 'ask_before_mutation'
  | 'auto_safe';

export const READ_ONLY_LITE_TOOLS = [
  'directory_list',
  'file_read',
  'semantic_search',
  'grep',
  'glob',
  'git_context',
  'web_search',
  'web_fetch',
] as const;

const MUTATING_ACTIONS = new Set<AgentAction['type']>([
  'write_file',
  'apply_patch',
  'run_command',
  'test_run',
]);

export function presetForVerb(verb: LiteSessionVerb): PermissionPreset {
  if (
    verb === 'ask' ||
    verb === 'plan' ||
    verb === 'propose' ||
    verb === 'diff' ||
    verb === 'patch'
  ) {
    return 'read_only';
  }
  return 'workspace_write';
}

export function executionProfileForPreset(preset: PermissionPreset): ExecutionProfileName {
  if (preset === 'read_only') {
    return 'read_only_audit';
  }
  return 'safe_repo';
}

export function allowedToolsForVerb(verb: LiteSessionVerb): string[] {
  const preset = presetForVerb(verb);
  return preset === 'read_only' ? [...READ_ONLY_LITE_TOOLS] : [];
}

export function decideAction(action: AgentAction, preset: PermissionPreset): PermissionDecision {
  if (preset === 'read_only' && MUTATING_ACTIONS.has(action.type)) {
    return 'deny';
  }
  if (preset === 'ask_before_mutation' && MUTATING_ACTIONS.has(action.type)) {
    return 'ask';
  }
  if (
    action.type === 'run_command' &&
    /\b(curl|wget|npm\s+install|pnpm\s+add|yarn\s+add)\b/i.test(action.command)
  ) {
    const decision = preset === 'auto_safe' ? ('ask' as const) : ('deny' as const);
    return decision;
  }
  return 'allow';
}

/** Deny-overrides-allow: explicit deny wins over allow. */
export function mergeDecisions(...decisions: PermissionDecision[]): PermissionDecision {
  if (decisions.includes('deny')) return 'deny';
  if (decisions.includes('ask')) return 'ask';
  return 'allow';
}

// ─── ReDoS safety limits ─────────────────────────────────────────────────
const MAX_PATTERN_LENGTH = 200;
const MAX_PATTERN_WILDCARDS = 10;
const PATTERN_CACHE_MAX_SIZE = 1000;
const patternCache = new Map<string, RegExp>();

function evictPatternCache(): void {
  if (patternCache.size > PATTERN_CACHE_MAX_SIZE) {
    // Drop oldest entries (insertion-order iteration)
    const excess = patternCache.size - PATTERN_CACHE_MAX_SIZE + 100;
    let count = 0;
    for (const key of patternCache.keys()) {
      if (count >= excess) break;
      patternCache.delete(key);
      count++;
    }
  }
}

/** Exported for testing — resets the internal pattern regex cache. */
export function clearPatternCache(): void {
  patternCache.clear();
}

// ─── Tool-level pattern permissions (Phase 3B) ────────────────────────────

export interface PermissionRule {
  /** Glob-style pattern: "file_write(src/**\/*.ts)", "shell_exec(git *)", "**" */
  pattern: string;
  decision: PermissionDecision;
  /** Human-readable reason for this rule */
  reason?: string;
}

export interface PermissionPatternSet {
  allow: PermissionRule[];
  deny: PermissionRule[];
}

/**
 * Parse a tool pattern string like "file_write(src/services/*.ts)"
 * into tool name and path/arg pattern components.
 */
export function parseToolPattern(pattern: string): { tool: string; pathPattern: string } | null {
  // Universal patterns match any tool
  if (pattern === '*' || pattern === '**') {
    return { tool: '*', pathPattern: '*' };
  }
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (match) {
    return { tool: match[1]?.toLowerCase() ?? '', pathPattern: match[2] ?? '*' };
  }
  // Bare tool name (no path constraint)
  if (/^\w+$/.test(pattern)) {
    return { tool: pattern.toLowerCase(), pathPattern: '*' };
  }
  return null;
}

/**
 * Simple glob match: supports * and ** wildcards.
 * "src/**\/*.ts" matches "src/services/foo.ts" AND "src/foo.ts" (zero directory levels).
 * "**\/*.ts" matches "foo.ts" (root-level files).
 */
export function patternMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === '**') return true;

  // ── Complexity guards (ReDoS hardening) ────────────────────────────
  if (pattern.length > MAX_PATTERN_LENGTH) {
    emitAgentEvent({
      type: 'malformed_config',
      source: 'patternMatch',
      detail: `Pattern exceeds max length (${pattern.length} > ${MAX_PATTERN_LENGTH}): ${pattern.slice(0, 50)}...`,
      severity: 'warn',
    });
    return false;
  }

  const wildcardCount = (pattern.match(/\*/g) ?? []).length;
  if (wildcardCount > MAX_PATTERN_WILDCARDS) {
    emitAgentEvent({
      type: 'malformed_config',
      source: 'patternMatch',
      detail: `Pattern exceeds max wildcards (${wildcardCount} > ${MAX_PATTERN_WILDCARDS}): ${pattern.slice(0, 50)}...`,
      severity: 'warn',
    });
    return false;
  }

  // ── Cache check ────────────────────────────────────────────────────
  const cached = patternCache.get(pattern);
  if (cached !== undefined) {
    return cached.test(value);
  }

  // Convert glob to regex with correct globstar semantics:
  // ** followed by / or at end = (?:.+/)? — matches zero or more path segments
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // **/ or /** — globstar followed by slash: zero or more directory levels (optional)
    .replace(/\*\*\\?\//g, '(?:.+/)?')
    // /\** — slash followed by globstar at end: optional trailing path
    .replace(/\\?\/\*\*$/g, '(?:/.*)?')
    // Bare ** not adjacent to slash — any characters including slashes
    .replace(/\*\*/g, '.*')
    // Single * — any characters except path separators
    .replace(/\*/g, '[^/\\\\]*');

  try {
    const regex = new RegExp(`^${regexSource}$`, 'i');

    // ── Cache insertion with eviction ────────────────────────────────
    evictPatternCache();
    patternCache.set(pattern, regex);

    return regex.test(value);
  } catch {
    return false;
  }
}

/**
 * Evaluate a set of permission rules against a tool name and optional target path.
 * Returns the merged decision across all matching rules.
 * Deny rules take priority over allow rules (fail-closed).
 */
export function evaluatePermissionRules(
  rules: PermissionPatternSet,
  tool: string,
  targetPath?: string,
  preset: PermissionPreset = 'workspace_write',
): PermissionDecision {
  const decisions: PermissionDecision[] = [];

  const normalizedTool = tool.toLowerCase();
  const normalizedPath = (targetPath ?? '').replace(/\\/g, '/');

  // Evaluate deny rules first (they take precedence)
  for (const rule of rules.deny) {
    const parsed = parseToolPattern(rule.pattern);
    if (!parsed) continue;
    if (parsed.tool !== normalizedTool && parsed.tool !== '*') continue;
    if (parsed.pathPattern === '*' || patternMatch(parsed.pathPattern, normalizedPath)) {
      emitAgentEvent({
        type: 'policy_decision',
        action: tool,
        decision: 'deny',
        preset,
        rule: rule.pattern,
      });
      return 'deny';
    }
  }

  // Evaluate allow rules
  for (const rule of rules.allow) {
    const parsed = parseToolPattern(rule.pattern);
    if (!parsed) continue;
    if (parsed.tool !== normalizedTool && parsed.tool !== '*') continue;
    if (parsed.pathPattern === '*' || patternMatch(parsed.pathPattern, normalizedPath)) {
      decisions.push(rule.decision);
    }
  }

  if (decisions.length === 0) {
    // Fail-closed: if rules exist but none matched, require human review
    const fallback: PermissionDecision =
      rules.allow.length > 0 || rules.deny.length > 0 ? 'ask' : 'allow';
    const event: Parameters<typeof emitAgentEvent>[0] = {
      type: 'policy_decision',
      action: tool,
      decision: fallback,
      preset,
    };
    if (fallback === 'ask') {
      event.rule = 'fail_closed_no_match';
    }
    emitAgentEvent(event);
    return fallback;
  }
  const merged = mergeDecisions(...decisions);
  emitAgentEvent({
    type: 'policy_decision',
    action: tool,
    decision: merged,
    preset,
  });
  return merged;
}

/**
 * Parse a comma-separated permission pattern string from CLI or config
 * into a structured rule set.
 *
 * Format: "allow:file_write(src/**),deny:shell_exec(curl *)"
 */
export function parsePermissionPatternString(input: string): PermissionPatternSet {
  const rules: PermissionPatternSet = { allow: [], deny: [] };
  const malformed: string[] = [];

  for (const segment of input.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) {
      malformed.push(trimmed);
      continue;
    }

    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    const pattern = trimmed.slice(colonIdx + 1).trim();
    if (!pattern) {
      malformed.push(trimmed);
      continue;
    }

    if (prefix === 'allow') {
      rules.allow.push({ pattern, decision: 'allow' });
    } else if (prefix === 'deny') {
      rules.deny.push({ pattern, decision: 'deny' });
    } else {
      malformed.push(trimmed);
    }
  }

  if (malformed.length > 0) {
    emitAgentEvent({
      type: 'malformed_config',
      source: 'parsePermissionPatternString',
      detail: `Malformed permission pattern segments skipped: ${malformed.join(', ')}`,
      severity: 'warn',
    });
  }

  return rules;
}

/**
 * Merge two PermissionPatternSets. Deny rules from both sets are combined.
 */
export function mergePermissionPatterns(
  a: PermissionPatternSet,
  b: PermissionPatternSet,
): PermissionPatternSet {
  const seenAllow = new Set<string>();
  const seenDeny = new Set<string>();

  function dedupe(rules: PermissionRule[], seen: Set<string>): PermissionRule[] {
    return rules.filter((r) => {
      if (seen.has(r.pattern)) return false;
      seen.add(r.pattern);
      return true;
    });
  }

  return {
    allow: dedupe([...a.allow, ...b.allow], seenAllow),
    deny: dedupe([...a.deny, ...b.deny], seenDeny),
  };
}

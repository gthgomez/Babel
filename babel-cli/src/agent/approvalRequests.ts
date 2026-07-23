/**
 * P1-D — Scoped approvals instead of unrecoverable denial.
 *
 * Eligible policy denials become ApprovalRequest events supporting:
 * deny | allow_once | allow_session | narrow_rule.
 */

import { randomUUID } from 'node:crypto';

export type ApprovalDecision =
  | 'deny'
  | 'allow_once'
  | 'allow_session'
  | 'narrow_rule';

export type ApprovalCapability =
  | 'network'
  | 'install'
  | 'shell'
  | 'write'
  | 'mcp'
  | 'other';

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface ApprovalRequest {
  request_id: string;
  thread_id: string;
  turn_id: string;
  command: string;
  cwd: string;
  capability: ApprovalCapability;
  risk: ApprovalRisk;
  /** Proposed reusable scope (e.g. "npm install *", "curl https://registry.npmjs.org/*"). */
  proposed_scope: string;
  reason: string;
  created_at: string;
}

export interface ApprovalResolution {
  request_id: string;
  decision: ApprovalDecision;
  /** For narrow_rule: the accepted scope pattern. */
  scope?: string;
  decided_at: string;
}

export interface ApprovalSessionState {
  thread_id: string;
  /** Session-wide allows (capability or scope keys). */
  sessionAllows: Set<string>;
  /** Narrow reusable rules (glob-like substring match). */
  rules: string[];
  /** Pending request (interactive only). */
  pending: ApprovalRequest | null;
  history: ApprovalResolution[];
  /** Parent permission scope ceiling for subagents. */
  parentScopeCeiling: ApprovalCapability[];
}

export function createApprovalSession(
  threadId: string,
  parentScopeCeiling: ApprovalCapability[] = [
    'network',
    'install',
    'shell',
    'write',
    'mcp',
    'other',
  ],
): ApprovalSessionState {
  return {
    thread_id: threadId,
    sessionAllows: new Set(),
    rules: [],
    pending: null,
    history: [],
    parentScopeCeiling,
  };
}

export function buildApprovalRequest(input: {
  thread_id: string;
  turn_id: string;
  command: string;
  cwd: string;
  capability: ApprovalCapability;
  risk?: ApprovalRisk;
  proposed_scope?: string;
  reason: string;
}): ApprovalRequest {
  return {
    request_id: randomUUID(),
    thread_id: input.thread_id,
    turn_id: input.turn_id,
    command: input.command,
    cwd: input.cwd,
    capability: input.capability,
    risk: input.risk ?? 'medium',
    proposed_scope:
      input.proposed_scope ??
      `${input.capability}:${input.command.split(/\s+/)[0] ?? '*'}`,
    reason: input.reason,
    created_at: new Date().toISOString(),
  };
}

function scopeKey(req: ApprovalRequest): string {
  return `${req.capability}::${req.proposed_scope}`;
}

/**
 * Match a narrow_rule against a request without over-broad substring allows.
 * Rejects empty/very short rules; prefers exact proposed_scope, then token boundaries.
 */
export function ruleMatchesRequest(rule: string, req: ApprovalRequest): boolean {
  const r = rule.trim();
  if (r.length < 2) return false;
  if (r === req.proposed_scope) return true;
  // Scope prefix with optional trailing wildcard (min 3 chars of substance)
  if (r.length >= 3) {
    const prefix = r.endsWith('*') ? r.slice(0, -1) : r;
    if (prefix.length >= 3 && req.proposed_scope.startsWith(prefix)) return true;
  }
  // Command: whole-token match only (min 3 chars — avoid "rm"/"ls" over-match)
  if (r.length < 3) return false;
  const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const re = new RegExp(`(?:^|[\\s;|&])${escaped}(?:$|[\\s;|&])`, 'i');
    return re.test(req.command);
  } catch {
    return false;
  }
}

/**
 * Check whether a request is already covered by session allow or rules.
 */
export function isPreApproved(
  state: ApprovalSessionState,
  req: ApprovalRequest,
): boolean {
  if (!state.parentScopeCeiling.includes(req.capability)) {
    return false;
  }
  if (state.sessionAllows.has(scopeKey(req))) return true;
  if (state.sessionAllows.has(req.capability)) return true;
  return state.rules.some((rule) => ruleMatchesRequest(rule, req));
}

/**
 * Headless / non-interactive: cannot surface approval UI.
 * Returns a deterministic deny result (never hangs).
 */
export function resolveApprovalHeadless(
  state: ApprovalSessionState,
  req: ApprovalRequest,
): ApprovalResolution {
  if (isPreApproved(state, req)) {
    const res: ApprovalResolution = {
      request_id: req.request_id,
      decision: 'allow_once',
      decided_at: new Date().toISOString(),
    };
    state.history.push(res);
    return res;
  }
  const res: ApprovalResolution = {
    request_id: req.request_id,
    decision: 'deny',
    decided_at: new Date().toISOString(),
  };
  state.history.push(res);
  return res;
}

/**
 * Apply an interactive decision to session state.
 */
export function applyApprovalDecision(
  state: ApprovalSessionState,
  req: ApprovalRequest,
  decision: ApprovalDecision,
  narrowScope?: string,
): ApprovalResolution {
  // Subagents cannot exceed parent permission scope.
  if (
    decision !== 'deny' &&
    !state.parentScopeCeiling.includes(req.capability)
  ) {
    const res: ApprovalResolution = {
      request_id: req.request_id,
      decision: 'deny',
      decided_at: new Date().toISOString(),
    };
    state.history.push(res);
    state.pending = null;
    return res;
  }

  const res: ApprovalResolution = {
    request_id: req.request_id,
    decision,
    decided_at: new Date().toISOString(),
    ...(decision === 'narrow_rule' && narrowScope
      ? { scope: narrowScope }
      : {}),
  };

  if (decision === 'allow_session') {
    state.sessionAllows.add(scopeKey(req));
    state.sessionAllows.add(req.capability);
  } else if (decision === 'narrow_rule') {
    const scope = narrowScope ?? req.proposed_scope;
    state.rules.push(scope);
    res.scope = scope;
  }
  // allow_once: no durable grant
  // deny: no grant

  state.history.push(res);
  state.pending = null;
  return res;
}

/**
 * Cap a child/subagent approval session to a subset of the parent ceiling.
 */
export function deriveSubagentApprovalSession(
  parent: ApprovalSessionState,
  childThreadId: string,
  allowed: ApprovalCapability[],
): ApprovalSessionState {
  const ceiling = allowed.filter((c) => parent.parentScopeCeiling.includes(c));
  const child = createApprovalSession(childThreadId, ceiling);
  // Inherit session allows only if capability remains in ceiling.
  for (const key of parent.sessionAllows) {
    const cap = key.split('::')[0] as ApprovalCapability;
    if (ceiling.includes(cap) || ceiling.includes(key as ApprovalCapability)) {
      child.sessionAllows.add(key);
    }
  }
  // Inherit narrow rules only when they do not clearly expand beyond the child ceiling.
  child.rules = parent.rules.filter((rule) => ruleFitsCeiling(rule, ceiling));
  return child;
}

/** Best-effort: drop rules that imply capabilities outside the child ceiling. */
function ruleFitsCeiling(rule: string, ceiling: ApprovalCapability[]): boolean {
  const r = rule.toLowerCase();
  if (/\b(curl|wget|invoke-webrequest|https?:\/\/)\b/.test(r) && !ceiling.includes('network')) {
    return false;
  }
  if (
    /\b(npm\s+i(nstall)?|pnpm\s+add|yarn\s+add|pip\s+install)\b/.test(r) &&
    !ceiling.includes('install')
  ) {
    return false;
  }
  if (/\b(mcp:|mcp_)\b/.test(r) && !ceiling.includes('mcp')) {
    return false;
  }
  return true;
}

/** Infer capability from a shell command for approval classification. */
export function inferCapabilityFromCommand(command: string): ApprovalCapability {
  if (/\b(npm\s+i(nstall)?|pnpm\s+add|yarn\s+add|pip\s+install)\b/i.test(command)) {
    return 'install';
  }
  if (/\b(curl|wget|Invoke-WebRequest|fetch)\b/i.test(command)) {
    return 'network';
  }
  if (/\b(rm|del|Remove-Item|git\s+push|git\s+reset)\b/i.test(command)) {
    return 'write';
  }
  return 'shell';
}

/**
 * Human-readable policy precedence table.
 *
 * At most one policy intervention is presented to the model per cycle.
 * Higher precedence wins; ties break by declaration order in the table.
 */

export type PolicyAction =
  | 'allow'
  | 'nudge'
  | 'restrict'
  | 'ask_approval'
  | 'deny'
  | 'terminal';

export type PolicySource =
  | 'hard_ceiling'
  | 'explicit_deny'
  | 'circuit_breaker'
  | 'external_blocker'
  | 'progress_terminal'
  | 'progress_recover'
  | 'progress_nudge'
  | 'ask_approval'
  | 'force_mutate'
  | 'investigate_budget'
  | 'shell_soft_budget'
  | 'read_thrash'
  | 'exploration_fuse'
  | 'stall'
  | 'zero_write'
  | 'completion_gate'
  | 'none';

export interface PolicyCandidate {
  source: PolicySource;
  action: PolicyAction;
  message: string;
  /** Optional expiry turn for restrict. */
  expiryTurn?: number;
}

/**
 * Precedence: lower index = higher priority.
 * Terminal/hard controls always beat soft nudges.
 */
export const POLICY_PRECEDENCE: readonly PolicySource[] = [
  'hard_ceiling',
  'explicit_deny',
  'circuit_breaker',
  'external_blocker',
  'progress_terminal',
  'completion_gate',
  'progress_recover',
  'ask_approval', // mapped via action; source stays explicit
  'progress_nudge',
  'force_mutate',
  'investigate_budget',
  'shell_soft_budget',
  'read_thrash',
  'exploration_fuse',
  'stall',
  'zero_write',
  'none',
] as const;

const precedenceIndex = new Map<PolicySource, number>(
  POLICY_PRECEDENCE.map((s, i) => [s, i]),
);

export function policyPrecedenceRank(source: PolicySource): number {
  return precedenceIndex.get(source) ?? POLICY_PRECEDENCE.length;
}

/**
 * Select at most one intervention for the cycle.
 * Returns null when all candidates are `allow` or list is empty.
 */
export function arbitratePolicy(
  candidates: PolicyCandidate[],
): PolicyCandidate | null {
  const active = candidates.filter((c) => c.action !== 'allow');
  if (active.length === 0) return null;

  active.sort((a, b) => {
    const ra = policyPrecedenceRank(a.source);
    const rb = policyPrecedenceRank(b.source);
    if (ra !== rb) return ra - rb;
    // Prefer stronger actions when same source rank.
    const strength: Record<PolicyAction, number> = {
      terminal: 0,
      deny: 1,
      ask_approval: 2,
      restrict: 3,
      nudge: 4,
      allow: 5,
    };
    return strength[a.action] - strength[b.action];
  });

  return active[0] ?? null;
}

/** Render the precedence table for docs / debugging. */
export function formatPolicyPrecedenceTable(): string {
  const lines = [
    '# Policy precedence (highest first)',
    '',
    '| Rank | Source | Typical action |',
    '|------|--------|----------------|',
  ];
  POLICY_PRECEDENCE.forEach((source, i) => {
    const typical =
      source === 'hard_ceiling' ||
      source === 'explicit_deny' ||
      source === 'circuit_breaker' ||
      source === 'external_blocker' ||
      source === 'progress_terminal'
        ? 'terminal'
        : source === 'progress_recover'
          ? 'recover'
          : source.startsWith('progress') ||
              source === 'force_mutate' ||
              source === 'read_thrash' ||
              source === 'stall' ||
              source === 'exploration_fuse' ||
              source === 'zero_write'
            ? 'nudge'
            : source === 'completion_gate'
              ? 'terminal/nudge'
              : 'allow';
    lines.push(`| ${i + 1} | ${source} | ${typical} |`);
  });
  lines.push('');
  lines.push(
    'Rule: at most one intervention is presented to the model per cycle.',
  );
  return lines.join('\n');
}

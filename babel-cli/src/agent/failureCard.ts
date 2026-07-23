/**
 * Human-readable failure/success card renderer.
 * Pure function — no I/O. Inputs come from harness + CLI payload.
 */

import type { PolicyEvent } from './policyEventLog.js';
import type { TurnRoutingReceipt } from './turnRoutingReceipt.js';
import type { ObservationTailEntry } from './observationTails.js';
import type { TurnSummary } from './turnSummaryScheduler.js';

export interface FailureCardInput {
  taskLabel: string;
  status: string;
  costUsd: number;
  turns: number;
  patchBytes: number;
  emptyPatch: boolean;
  modelsUsed: string[];
  proCostShare: number;
  lastTools: Array<{ tool: string; target: string }>;
  policyEventCounts: Partial<Record<string, number>>;
  topBlockedReasons?: Array<{ reason: string; count: number }>;
  observationTails?: ObservationTailEntry[];
  turnSummaries?: TurnSummary[];
  recommendedAction?: string;
  runDir?: string;
  transcriptPath?: string;
  /** W0.4: environment/toolchain blocked (distinct from policy thrash). */
  envBlocked?: boolean;
  /** Optional ENV_BLOCKED card body from implementorPolicy. */
  envBlockedCard?: string;
}

export function renderFailureCard(input: FailureCardInput): string {
  const lines: string[] = [];
  const statusLabel =
    input.envBlocked || input.status === 'ENV_BLOCKED'
      ? 'ENV_BLOCKED'
      : input.status;
  lines.push(`# ${input.taskLabel} — ${statusLabel}`);
  lines.push('');
  lines.push(`- **Cost**: $${input.costUsd.toFixed(2)} | **Turns**: ${input.turns} | **Patch**: ${input.patchBytes === 0 ? '0 B' : `${input.patchBytes} B`}`);

  if (input.envBlocked || input.status === 'ENV_BLOCKED') {
    lines.push(
      `- **Env**: blocked (toolchain/runtime unavailable — not a policy thrash kill; empty_patch KPI quarantined)`,
    );
  }

  const flashShare = 1 - input.proCostShare;
  lines.push(`- **Models**: flash ${Math.round(flashShare * 100)}% / pro ${Math.round(input.proCostShare * 100)}%`);

  if (input.lastTools.length > 0) {
    const toolSummary = input.lastTools.slice(-5).map(t => t.tool).join(' → ');
    lines.push(`- **Last tools**: ${toolSummary}`);
  }

  // Policy events summary
  const policyEntries = Object.entries(input.policyEventCounts);
  if (policyEntries.length > 0) {
    const policySummary = policyEntries
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 5)
      .map(([k, v]) => `${k}×${v}`)
      .join(', ');
    lines.push(`- **Policy**: ${policySummary}`);
  }

  // Blocked attempts
  if (input.topBlockedReasons && input.topBlockedReasons.length > 0) {
    const blockedSummary = input.topBlockedReasons
      .map(r => `${r.reason}×${r.count}`)
      .join(', ');
    lines.push(`- **Top blocked attempts**: ${blockedSummary}`);
  }

  // Turn summaries (B2)
  if (input.turnSummaries && input.turnSummaries.length > 0) {
    lines.push('');
    lines.push('## Turn decision summaries');
    lines.push('');
    for (const summary of input.turnSummaries.slice(-3)) {
      lines.push(`### Turn ${summary.turn + 1} (${summary.ts.slice(0, 19).replace('T', ' ')})`);
      lines.push(`- **Hypothesis**: ${summary.hypothesis}`);
      const files = summary.files_of_interest.slice(0, 5).join(', ');
      if (files) lines.push(`- **Files**: ${files}`);
      lines.push(`- **Next tool**: ${summary.next_tool}`);
      const blockers = summary.blockers.slice(0, 3).join('; ');
      if (blockers) lines.push(`- **Blockers**: ${blockers}`);
      lines.push('');
    }
  }

  // Observation tails
  if (input.observationTails && input.observationTails.length > 0) {
    lines.push('');
    lines.push('## Last observation tails');
    lines.push('');
    for (const tail of input.observationTails.slice(-3)) {
      lines.push(`### ${tail.tool}: \`${tail.target}\`${tail.exit_code !== undefined ? ` (exit ${tail.exit_code})` : ''}`);
      lines.push('');
      lines.push('```');
      lines.push(tail.tail.slice(0, 500));
      lines.push('```');
      lines.push('');
    }
  }

  // Recommended action
  if (input.recommendedAction) {
    lines.push(`- **Recommended next action**: ${input.recommendedAction}`);
  }

  // Paths
  if (input.runDir) {
    lines.push(`- **Run dir**: \`${input.runDir}\``);
  }
  if (input.transcriptPath) {
    lines.push(`- **Transcript**: \`${input.transcriptPath}\``);
  }

  if (input.envBlockedCard) {
    lines.push('');
    lines.push(input.envBlockedCard.trim());
  }

  return lines.join('\n') + '\n';
}

// ─── U1.1: In-session tool timeline + interactive card ─────────────────────

export interface ToolCallEntry {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
}

/**
 * Format the last N tool calls as human-readable lines.
 * Pure function — no I/O. Returns empty string when toolCalls is empty/missing.
 */
export function formatSessionToolTimeline(
  toolCalls: ToolCallEntry[] | undefined,
  n: number = 5,
): string {
  if (!toolCalls || toolCalls.length === 0) return '';
  const lastN = toolCalls.slice(-n);
  const lines: string[] = [];
  for (const tc of lastN) {
    const shortTarget =
      tc.target.length > 60 ? tc.target.slice(0, 57) + '...' : tc.target;
    const status = tc.error ? '✗' : '✓';
    lines.push(`  ${status} ${tc.tool} ${shortTarget}`);
  }
  const label =
    lastN.length < (toolCalls.length ?? 0)
      ? `Last ${lastN.length} of ${toolCalls.length} tools:`
      : `Last ${lastN.length} tool${lastN.length !== 1 ? 's' : ''}:`;
  return `${label}\n${lines.join('\n')}`;
}

export interface InteractiveCardInput {
  status: string;
  costUsd?: number | undefined;
  lastTools?: ToolCallEntry[] | undefined;
  recommendedAction?: string | undefined;
}

/**
 * Build a compact card body for interactive fail/blocked display.
 * Returns a muted summary the operator can read without opening harness JSON.
 */
export function buildInteractiveCard(input: InteractiveCardInput): string {
  const lines: string[] = [];
  const label = input.status.toUpperCase();
  lines.push(`── ${label} ──`);
  if (input.costUsd !== undefined) {
    lines.push(`  Cost: $${input.costUsd.toFixed(4)}`);
  }
  if (input.lastTools && input.lastTools.length > 0) {
    lines.push(formatSessionToolTimeline(input.lastTools));
  }
  if (input.recommendedAction) {
    lines.push(`  Next: ${input.recommendedAction}`);
  }
  return lines.join('\n');
}

export function renderSuccessCard(input: FailureCardInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.taskLabel} — PASSED ✓`);
  lines.push('');
  lines.push(`- **Cost**: $${input.costUsd.toFixed(2)} | **Turns**: ${input.turns} | **Patch**: ${input.patchBytes} B`);
  lines.push(`- **Models**: ${input.modelsUsed.join(', ')}`);

  if (input.runDir) {
    lines.push(`- **Run dir**: \`${input.runDir}\``);
  }
  if (input.transcriptPath) {
    lines.push(`- **Transcript**: \`${input.transcriptPath}\``);
  }

  return lines.join('\n') + '\n';
}

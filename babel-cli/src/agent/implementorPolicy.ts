/**
 * Implementor Roadmap v1 — pure policy helpers.
 * Bias the chat loop toward localize → mutate → verify (not eternal explore).
 * No I/O. Unit-tested.
 */

import type { ChatPhase } from './chatPhaseNudge.js';
import { isDirectMutationTool } from './mutationTools.js';

/** Shell-like tools that are not file mutations. */
const SHELL_TOOLS = new Set([
  'run_command',
  'shell_exec',
  'test_run',
  'bash',
  'shell',
]);

/** File-localizing tools (happy-path explore). */
const FILE_LOCALIZE_TOOLS = new Set([
  'read_file',
  'read_range',
  'grep',
  'glob',
  'workspace_symbol_search',
  'list_dir',
  'semantic_search',
]);

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

export function isFileLocalizeTool(toolName: string): boolean {
  return FILE_LOCALIZE_TOOLS.has(toolName);
}

/**
 * Soft pressure after N consecutive non-mutating shell tools.
 * Returns a model-facing nudge (not a hard block).
 */
export function evaluateShellSoftBudget(input: {
  consecutiveNonMutatingShells: number;
  budget: number;
  hasAnyWrites: boolean;
}): { fire: boolean; message: string | null } {
  if (input.hasAnyWrites) return { fire: false, message: null };
  if (input.budget <= 0) return { fire: false, message: null };
  if (input.consecutiveNonMutatingShells < input.budget) {
    return { fire: false, message: null };
  }
  return {
    fire: true,
    message: [
      '[Implementor: shell soft budget]',
      `You used ${input.consecutiveNonMutatingShells} consecutive shell/test commands without a file mutation.`,
      'Prefer str_replace / write_file for the fix; use shell only to verify a patch that already exists.',
      'If the environment cannot run tests, say so and leave the patch ready (env_blocked), do not thrash pytest.',
    ].join(' '),
  };
}

/**
 * After too many tools still in investigate with zero writes, return a
 * force-mutate *candidate* message (soft — does not kill the run).
 */
export function evaluateInvestigateToolBudget(input: {
  toolCallCount: number;
  budget: number;
  hasAnyWrites: boolean;
  phase: ChatPhase | null;
}): { fire: boolean; message: string | null } {
  if (input.hasAnyWrites) return { fire: false, message: null };
  if (input.budget <= 0) return { fire: false, message: null };
  if (input.toolCallCount < input.budget) return { fire: false, message: null };
  // Only pressure while still exploring or stuck without writes
  if (input.phase === 'verify') return { fire: false, message: null };
  return {
    fire: true,
    message: [
      '[Implementor: investigate budget]',
      `You have used ${input.toolCallCount} tools without writing a patch.`,
      'Stop broad exploration. Apply the fix with str_replace (preferred) or write_file now.',
      'If you lack a target path, pick the best candidate from prior reads and edit it.',
    ].join(' '),
  };
}

/**
 * Write-affordant phase rule: shell/test alone must not count as “ready to verify”.
 * Localization evidence = at least one file-localize tool or any mutation.
 */
export function hasLocalizationEvidence(toolNames: string[]): boolean {
  return toolNames.some(
    (n) => isFileLocalizeTool(n) || isDirectMutationTool(n),
  );
}

/**
 * Completion without a patch is suspicious on execute tasks.
 * Returns whether the harness should refuse silent complete / prefer env_blocked.
 */
export function evaluateCompletionPrefersPatch(input: {
  executeIntent: boolean;
  hasAnyWrites: boolean;
  operatorConfirmedNoWrite?: boolean;
  envBlocked?: boolean;
}): {
  allowComplete: boolean;
  reason:
    | 'ok_has_writes'
    | 'ok_operator_confirm'
    | 'ok_env_blocked'
    | 'ok_not_execute'
    | 'refuse_empty_complete';
  message: string | null;
} {
  if (!input.executeIntent) {
    return { allowComplete: true, reason: 'ok_not_execute', message: null };
  }
  if (input.hasAnyWrites) {
    return { allowComplete: true, reason: 'ok_has_writes', message: null };
  }
  if (input.envBlocked) {
    return { allowComplete: true, reason: 'ok_env_blocked', message: null };
  }
  if (input.operatorConfirmedNoWrite) {
    return { allowComplete: true, reason: 'ok_operator_confirm', message: null };
  }
  return {
    allowComplete: false,
    reason: 'refuse_empty_complete',
    message: [
      '[Implementor: completion prefers patch]',
      'Execute tasks should produce a file mutation before claiming done.',
      'Apply str_replace/write_file, or report env_blocked if verification is impossible,',
      'or explicitly confirm no-write completion with the operator.',
    ].join(' '),
  };
}

/** Detect common “pytest/node missing” / env failure signals in observation text. */
export function detectEnvBlockedFromText(text: string): boolean {
  const t = text.toLowerCase();
  if (/\benv_blocked\b/.test(t)) return true;
  if (/\benvironment (is )?(not |un)(available|ready|configured)\b/.test(t)) return true;

  const missing =
    /\bnot found\b/.test(t) ||
    /\bis not recognized\b/.test(t) ||
    /\bno module named\b/.test(t) ||
    /\bcommand not found\b/.test(t) ||
    /\bcannot find\b/.test(t) ||
    /\bcould not find\b/.test(t) ||
    /\benoent\b/.test(t) ||
    /\bwas not found\b/.test(t) ||
    /\bno such file or directory\b/.test(t);

  const toolchain =
    /\bpytest\b/.test(t) ||
    /\bnpm\b/.test(t) ||
    /\bnpx\b/.test(t) ||
    /\bnode\b/.test(t) ||
    /\bpython\b/.test(t) ||
    /\bpython3\b/.test(t) ||
    /\bpip\b/.test(t) ||
    /\btsc\b/.test(t);

  return toolchain && missing;
}

/** Scan tool log detail/error/stdout/stderr for env-red signals. */
export function detectEnvBlockedFromToolLog(
  toolCalls: Array<{
    detail?: string;
    error?: string;
    stdout?: string;
    stderr?: string;
  }>,
): boolean {
  for (const t of toolCalls) {
    const blob = [t.detail, t.error, t.stdout, t.stderr].filter(Boolean).join('\n');
    if (blob && detectEnvBlockedFromText(blob)) return true;
  }
  return false;
}

/**
 * Empty-patch KPI honesty (C-TL-04 / S-EVL-04).
 * Env-blocked terminals must not count as empty-patch *failures* in prove suites.
 */
export function classifyEmptyPatchHonesty(input: {
  emptyPatch: boolean;
  envBlocked: boolean;
}): {
  scoreAsEmptyPatchFailure: boolean;
  reason: 'not_empty' | 'env_blocked_quarantine' | 'true_empty';
} {
  if (!input.emptyPatch) {
    return { scoreAsEmptyPatchFailure: false, reason: 'not_empty' };
  }
  if (input.envBlocked) {
    return { scoreAsEmptyPatchFailure: false, reason: 'env_blocked_quarantine' };
  }
  return { scoreAsEmptyPatchFailure: true, reason: 'true_empty' };
}

/**
 * Resolve harness-facing implementor fields for a finished chat run.
 * ENV_BLOCKED is distinct from policy BLOCKED and from empty ANSWER_READY success.
 */
export function resolveImplementorHarnessFields(input: {
  answer?: string;
  toolCalls?: Array<{
    tool: string;
    detail?: string;
    error?: string;
    stdout?: string;
    stderr?: string;
  }>;
  hasAnyWrites: boolean;
  emptyPatch: boolean;
  legacyAnswerStatus: string;
}): {
  env_blocked: boolean;
  status: string;
  empty_patch_scoreable: boolean;
  empty_patch_score_reason: string;
  failure_class_hint: string | null;
  operator_card: string | null;
} {
  const envBlocked =
    detectEnvBlockedFromText(input.answer ?? '') ||
    detectEnvBlockedFromToolLog(input.toolCalls ?? []);
  const honesty = classifyEmptyPatchHonesty({
    emptyPatch: input.emptyPatch,
    envBlocked,
  });

  let status = input.legacyAnswerStatus;
  if (envBlocked && !input.hasAnyWrites) {
    // Missing toolchain without a patch is not a clean success.
    status = 'ENV_BLOCKED';
  } else if (envBlocked && input.hasAnyWrites) {
    // Patch present; keep readiness but surface env flag (do not mask as fail).
    status = input.legacyAnswerStatus === 'ANSWER_READY' ? 'ANSWER_READY' : input.legacyAnswerStatus;
  }

  return {
    env_blocked: envBlocked,
    status,
    empty_patch_scoreable: honesty.scoreAsEmptyPatchFailure,
    empty_patch_score_reason: honesty.reason,
    failure_class_hint: envBlocked ? 'env_blocked' : null,
    operator_card: envBlocked
      ? formatEnvBlockedOperatorCard({
          hasAnyWrites: input.hasAnyWrites,
          signal: extractEnvBlockedSignal(input.answer ?? '', input.toolCalls ?? []),
        })
      : null,
  };
}

function extractEnvBlockedSignal(
  answer: string,
  toolCalls: Array<{ detail?: string; error?: string; stdout?: string; stderr?: string }>,
): string {
  if (detectEnvBlockedFromText(answer)) {
    return answer.slice(0, 160).replace(/\s+/g, ' ').trim();
  }
  for (const t of toolCalls) {
    const blob = [t.detail, t.error, t.stdout, t.stderr].filter(Boolean).join(' ');
    if (blob && detectEnvBlockedFromText(blob)) {
      return blob.slice(0, 160).replace(/\s+/g, ' ').trim();
    }
  }
  return 'environment toolchain unavailable';
}

/** Compact operator card line for ENV_BLOCKED (failure/success card companion). */
export function formatEnvBlockedOperatorCard(input: {
  hasAnyWrites: boolean;
  signal: string;
}): string {
  const patch = input.hasAnyWrites
    ? 'Patch present — verification blocked by environment, not by missing work.'
    : 'No patch yet — environment cannot run verification tools.';
  return [
    '## ENV_BLOCKED',
    '',
    `- **Kind**: environment / toolchain (not policy thrash)`,
    `- **Signal**: ${input.signal}`,
    `- **Patch**: ${patch}`,
    `- **Operator**: install/fix runtime (pytest/node/npm/python) or re-run on a ready machine; do not score as empty_patch fail.`,
  ].join('\n');
}

/**
 * Classify terminal status for implementor honesty.
 * ENV_BLOCKED is distinct from BLOCKED (policy) and NEEDS_MORE_CONTEXT.
 */
export type ImplementorTerminalStatus =
  | 'ANSWER_READY'
  | 'BLOCKED'
  | 'ENV_BLOCKED'
  | 'BUDGET_EXCEEDED'
  | 'NEEDS_MORE_CONTEXT'
  | 'CANCELLED';

export function classifyImplementorTerminal(input: {
  status: 'completed' | 'failed' | 'cancelled' | 'blocked';
  hasAnyWrites: boolean;
  envBlocked?: boolean;
  budgetExceeded?: boolean;
  answer?: string;
}): ImplementorTerminalStatus {
  if (input.status === 'cancelled') return 'CANCELLED';
  if (input.budgetExceeded) return 'BUDGET_EXCEEDED';
  if (input.envBlocked || (input.answer && detectEnvBlockedFromText(input.answer))) {
    return 'ENV_BLOCKED';
  }
  if (input.status === 'completed') return 'ANSWER_READY';
  if (input.status === 'blocked') return 'BLOCKED';
  return 'NEEDS_MORE_CONTEXT';
}

/** True when a policy event is a phase-gate block (write or search). */
export function isPhaseGatePolicyEvent(kind: string, detail?: string): boolean {
  if (kind === 'phase_gate_block' || kind === 'phase_gate') return true;
  return typeof detail === 'string' && detail.includes('phase-gate');
}

/**
 * W1.2 / Wave 1 exit #3 — count phase-gate blocks for harness + /why-stopped.
 * Write blocks = phase-gate events (or ledger rows) on direct mutation tools.
 */
export function countPhaseGateWriteBlocks(input: {
  policyEvents?: Array<{ kind: string; detail?: string; tool?: string }>;
  blockedAttempts?: Array<{ reason: string; tool: string }>;
}): {
  phase_gate_block_count: number;
  phase_gate_write_block_count: number;
  write_blocked_tools: string[];
  /** Operator-visible line, e.g. "write blocked: phase-gate ×2 (str_replace, write_file)" */
  visibility_line: string | null;
} {
  const events = input.policyEvents ?? [];
  const phaseEvents = events.filter((e) => isPhaseGatePolicyEvent(e.kind, e.detail));
  const writeFromEvents = phaseEvents.filter((e) => e.tool != null && isDirectMutationTool(e.tool));

  const ledger = input.blockedAttempts ?? [];
  const writeFromLedger = ledger.filter(
    (a) => a.reason === 'phase-gate' && isDirectMutationTool(a.tool),
  );

  // Prefer ledger write count when present (post-sync accuracy); else event tools.
  const phase_gate_write_block_count =
    writeFromLedger.length > 0 ? writeFromLedger.length : writeFromEvents.length;
  const phase_gate_block_count = Math.max(phaseEvents.length, ledger.filter((a) => a.reason === 'phase-gate').length);

  const write_blocked_tools = [
    ...new Set([
      ...writeFromEvents.map((e) => e.tool!).filter(Boolean),
      ...writeFromLedger.map((a) => a.tool),
    ]),
  ];

  const visibility_line =
    phase_gate_write_block_count > 0
      ? `write blocked: phase-gate ×${phase_gate_write_block_count}` +
        (write_blocked_tools.length > 0 ? ` (${write_blocked_tools.join(', ')})` : '')
      : phase_gate_block_count > 0
        ? `phase-gate blocks: ${phase_gate_block_count} (non-write / search)`
        : null;

  return {
    phase_gate_block_count,
    phase_gate_write_block_count,
    write_blocked_tools,
    visibility_line,
  };
}

/**
 * Wave 1 exit #3 — baseline comparison for phase-gate write blocks.
 * Call with a prior median/count to start tracking trend (trend-down is the goal).
 */
export function comparePhaseGateWriteBlockBaseline(input: {
  currentWriteBlocks: number;
  /** Prior baseline count (null = baseline not yet established). */
  baselineWriteBlocks?: number | null;
}): {
  baseline_started: boolean;
  current: number;
  baseline: number | null;
  delta: number | null;
  improved: boolean | null;
  note: string;
} {
  const baseline =
    input.baselineWriteBlocks === undefined || input.baselineWriteBlocks === null
      ? null
      : input.baselineWriteBlocks;
  if (baseline === null) {
    return {
      baseline_started: true,
      current: input.currentWriteBlocks,
      baseline: null,
      delta: null,
      improved: null,
      note: `Baseline established at ${input.currentWriteBlocks} phase-gate write block(s); compare next runs to this.`,
    };
  }
  const delta = input.currentWriteBlocks - baseline;
  return {
    baseline_started: true,
    current: input.currentWriteBlocks,
    baseline,
    delta,
    improved: delta < 0,
    note:
      delta < 0
        ? `Improved: ${input.currentWriteBlocks} vs baseline ${baseline} (Δ ${delta}).`
        : delta === 0
          ? `Unchanged vs baseline ${baseline}.`
          : `Regressed: ${input.currentWriteBlocks} vs baseline ${baseline} (Δ +${delta}).`,
  };
}

/**
 * Build a short “why stopped” operator line from policy events + status.
 */
export function formatWhyStopped(input: {
  status: string;
  hasAnyWrites: boolean;
  lastPolicyEvents?: Array<{ kind: string; detail?: string; at_turn?: number; tool?: string }>;
  topBlockedReason?: string;
  envBlocked?: boolean;
  blockedAttempts?: Array<{ reason: string; tool: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`Status: ${input.status}`);
  lines.push(`Writes: ${input.hasAnyWrites ? 'yes' : 'no'}`);
  if (input.envBlocked) {
    lines.push('Env: blocked (tests/runtime unavailable — not a policy thrash kill)');
  }
  if (input.topBlockedReason) {
    lines.push(`Top blocked attempt: ${input.topBlockedReason}`);
  }
  const events = input.lastPolicyEvents ?? [];
  const phaseMetrics = countPhaseGateWriteBlocks({
    policyEvents: events,
    ...(input.blockedAttempts ? { blockedAttempts: input.blockedAttempts } : {}),
  });
  if (phaseMetrics.visibility_line) {
    lines.push(phaseMetrics.visibility_line);
  }
  if (events.length > 0) {
    const last = events[events.length - 1]!;
    lines.push(
      `Last policy: ${last.kind}${last.detail ? ` (${last.detail})` : ''}` +
        (last.at_turn !== undefined ? ` @ turn ${last.at_turn}` : ''),
    );
    if (phaseMetrics.phase_gate_block_count > 0) {
      lines.push(
        `Phase-gate events: ${phaseMetrics.phase_gate_block_count}` +
          (phaseMetrics.phase_gate_write_block_count > 0
            ? ` (${phaseMetrics.phase_gate_write_block_count} write block(s))`
            : ''),
      );
    }
  } else {
    lines.push('Last policy: (none recorded)');
  }
  if (!input.hasAnyWrites && input.status !== 'ENV_BLOCKED') {
    lines.push(
      'Hint: zero writes — check force_mutate / read thrash / phase-gate / shell thrash in policy timeline.',
    );
  }
  return lines.join('\n');
}

/** Ranking hint for coding profiles: prefer file tools over shell when both listed. */
export function rankToolsFileFirst(toolNames: string[]): string[] {
  return [...toolNames].sort((a, b) => {
    const score = (n: string) =>
      isDirectMutationTool(n) ? 0 : isFileLocalizeTool(n) ? 1 : isShellTool(n) ? 3 : 2;
    return score(a) - score(b);
  });
}

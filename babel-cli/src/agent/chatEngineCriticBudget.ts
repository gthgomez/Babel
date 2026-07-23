/**
 * Diff-critic + budget helpers extracted from ChatEngine (file-size ratchet).
 * Keeps the agent loop thin; all strike/hard-block policy stays here.
 */

import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import type { BlockedReport } from '../schemas/agentContracts.js';
import { isSweChatProfileEnabled } from '../config/chatEngineLimits.js';
import {
  buildDiffCriticRejectionMessage,
  collectWorkspacePatch,
  decideDiffCriticGate,
  isDiffCriticEnabled,
  isSweCriticTierEnabled,
  resolveDiffCriticModel,
  resolveDiffCriticProModel,
  runDiffCritic,
  runHeuristicDiffCritic,
  type DiffCriticVerdict,
} from './diffCritic.js';
import { formatBudgetExceededAnswer } from './budgetKillPolicy.js';
import { isSuccessfulDirectMutation } from './mutationTools.js';
import type { ChatMessage } from './chatToolDefinitions.js';

export type CriticToolLogEntry = {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
};

export type CriticGateDecision = 'allow' | 'reject' | 'block';

export const MAX_CRITIC_STRIKES = 2;

/** Session has successful sub-agent mutations (detail: "N changed"). */
export function hasSubAgentWrites(toolCallLog: CriticToolLogEntry[]): boolean {
  return toolCallLog.some(
    (e) =>
      e.tool === 'sub_agent' &&
      e.error !== 'blocked' &&
      /[1-9]\d*\s+changed/.test(e.detail ?? ''),
  );
}

/** Successful direct file writes or sub-agent mutations. */
export function hasAnyWrites(toolCallLog: CriticToolLogEntry[]): boolean {
  return (
    toolCallLog.some((e) => isSuccessfulDirectMutation(e.tool, e.error)) ||
    hasSubAgentWrites(toolCallLog)
  );
}

export function buildGateRejectionMessage(toolCallLog: CriticToolLogEntry[]): string {
  const writeCount = toolCallLog.filter((e) =>
    isSuccessfulDirectMutation(e.tool, e.error),
  ).length;
  const subAgentCount = toolCallLog.filter(
    (e) => e.tool === 'sub_agent' && /\d+\s+changed/.test(e.detail ?? ''),
  ).length;
  const lastActions = toolCallLog.slice(-3).map((e) => e.tool).join(', ');
  if (writeCount + subAgentCount === 0) {
    return [
      `Gate check: 0 file writes, 0 sub-agent mutations.`,
      `Last 3 actions: ${lastActions || 'none'}.`,
      'You have not made any file changes. Use str_replace or write_file to apply the fix, then run the verifier before finishing.',
    ].join(' ');
  }
  return [
    `Gate check: ${writeCount} file writes, ${subAgentCount} sub-agent mutations.`,
    `Last 3 actions: ${lastActions || 'none'}.`,
    'Run the verifier (test_run or run_command) before completing.',
  ].join(' ');
}

export function currentTurnHasMutation(
  toolCallLog: CriticToolLogEntry[],
  turnStart: number,
): boolean {
  return toolCallLog.slice(turnStart).some(
    (e) =>
      isSuccessfulDirectMutation(e.tool, e.error) ||
      (e.tool === 'sub_agent' &&
        e.error !== 'blocked' &&
        /\d+\s+changed/.test(e.detail ?? '')),
  );
}

export function checkCostWallBudgets(input: {
  totalCostUsd: number;
  maxCostUsd: number;
  sessionStartTime: number;
  maxWallMs: number;
}): { ok: boolean; reason?: string } {
  if (input.totalCostUsd >= input.maxCostUsd) {
    return {
      ok: false,
      reason: `Cost budget exceeded ($${input.totalCostUsd.toFixed(2)} of $${input.maxCostUsd.toFixed(2)}).`,
    };
  }
  if (input.sessionStartTime > 0) {
    const elapsed = Date.now() - input.sessionStartTime;
    if (elapsed >= input.maxWallMs) {
      return {
        ok: false,
        reason: `Time budget exceeded (${Math.round(elapsed / 1000)}s of ${Math.round(input.maxWallMs / 1000)}s).`,
      };
    }
  }
  return { ok: true };
}

export function buildCriticBlockedReport(
  verdict: DiffCriticVerdict,
  criticStrikes: number,
): BlockedReport {
  const primary =
    verdict.reasons.find((r) => !r.startsWith('hard-block')) ??
    verdict.reasons[0] ??
    'critic rejected without detail';
  return {
    schema_version: 1,
    status: 'BLOCKED',
    reason: `Diff critic rejected the patch after ${criticStrikes} strike(s) — refusing soft-allow of a still-wrong completion`,
    missing:
      'A patch that correctly addresses the task root cause (independent critic still rejects)',
    checked: [
      {
        action: 'diff_critic',
        target: 'workspace_patch_vs_task',
        finding: primary.slice(0, 500),
      },
      ...verdict.reasons.slice(0, 4).map((r, i) => ({
        action: 'diff_critic_reason',
        target: `reason_${i + 1}`,
        finding: r.slice(0, 500),
      })),
    ],
    next_steps: [
      'Re-read the task root cause and preferred fix symbols/methods',
      'Replace the incorrect localization in the patch',
      'Re-run the verifier, then complete again',
    ],
  };
}

export function buildCriticBlockedAnswer(report: BlockedReport): string {
  return [
    `BLOCKED: ${report.reason}`,
    `Missing: ${report.missing}`,
    ...(report.checked ?? []).slice(0, 3).map((c) => `- [${c.action}] ${c.finding}`),
  ].join('\n');
}

export function mutationTargetsFromLog(toolCallLog: CriticToolLogEntry[]): string[] {
  return toolCallLog
    .filter((e) => isSuccessfulDirectMutation(e.tool, e.error) && e.target)
    .map((e) => e.target!)
    .filter((t, i, arr) => arr.indexOf(t) === i);
}

export type CriticRunner = DeepInfraApiRunner | DeepSeekApiRunner;

export function resolveOrCreateCriticRunner(
  modelId: string,
  cached: CriticRunner | null,
  fallback: () => CriticRunner,
): { runner: CriticRunner; cache: CriticRunner } {
  if (cached) return { runner: cached, cache: cached };
  const lower = modelId.toLowerCase();
  let runner: CriticRunner;
  try {
    runner = lower.includes('deepseek')
      ? new DeepSeekApiRunner(modelId)
      : new DeepInfraApiRunner(modelId);
  } catch {
    try {
      runner = new DeepSeekApiRunner('deepseek-v4-flash');
    } catch {
      runner = fallback();
    }
  }
  return { runner, cache: runner };
}

export function resolveOrCreateCriticProRunner(
  modelId: string,
  cached: CriticRunner | null,
  flashFallback: () => CriticRunner,
): { runner: CriticRunner; cache: CriticRunner } {
  if (cached) return { runner: cached, cache: cached };
  const lower = modelId.toLowerCase();
  let runner: CriticRunner;
  try {
    runner = lower.includes('deepseek')
      ? new DeepSeekApiRunner(modelId)
      : new DeepInfraApiRunner(modelId);
  } catch {
    runner = flashFallback();
  }
  return { runner, cache: runner };
}

/**
 * Critic LLM call with isolated AbortController — does not poison session abort.
 */
export async function executeCriticWithTimeout(
  runner: CriticRunner,
  prompt: string,
  systemPrompt: string | undefined,
  session: {
    cancelled: boolean;
    abortController: AbortController;
    timeoutMs: number;
  },
): Promise<string> {
  if (session.cancelled || session.abortController.signal.aborted) {
    throw new Error('Critic aborted: session already cancelled');
  }

  const criticController = new AbortController();
  const onParentAbort = () => criticController.abort();
  session.abortController.signal.addEventListener('abort', onParentAbort, {
    once: true,
  });

  const execPromise = runner.executeRaw(
    prompt,
    undefined,
    systemPrompt,
    criticController.signal,
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      criticController.abort();
      reject(
        new Error(
          `Critic timed out after ${session.timeoutMs / 1000}s without a response`,
        ),
      );
    }, session.timeoutMs);
  });

  try {
    return await Promise.race([execPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    session.abortController.signal.removeEventListener('abort', onParentAbort);
    execPromise.catch(() => {});
  }
}

export interface AsymmetricCriticState {
  toolCallLog: CriticToolLogEntry[];
  conversation: ChatMessage[];
  projectRoot: string;
  task: string;
  lastVerifierReceipt: {
    command: string;
    exit_code: number;
    summary: string;
  } | null;
  lastCriticReceipt: DiffCriticVerdict | null;
  criticStrikes: number;
  criticRunner: CriticRunner | null;
  criticProRunner: CriticRunner | null;
  cancelled: boolean;
  abortController: AbortController;
  turnTimeoutMs: number;
  resolveDeliberationRunner: () => CriticRunner;
  trackRunnerUsage: (runner: CriticRunner) => void;
  onThought?: ((msg: string) => void) | undefined;
}

/**
 * Observability receipt for pre-completion paths that do not run the LLM critic.
 * Always set so harness rollups can distinguish never-ran / disabled / no_writes
 * from a real pass|reject (C1 — silent early-return left criticVerdict=null).
 */
export function buildCriticSkipReceipt(
  skippedReason: string,
  reason: string,
): DiffCriticVerdict {
  return {
    verdict: 'skip',
    reasons: [reason],
    confidence: 0,
    skippedReason,
  };
}

/**
 * Pre-completion asymmetric critic. Mutates state (strikes, receipt, conversation).
 *
 * Early returns still write a skip receipt (C1) so CLI payloads expose
 * critic_receipt for benchmark rollups.
 */
export async function runAsymmetricDiffCritic(
  state: AsymmetricCriticState,
  answer: string,
  taskIntent: 'execute' | 'explain',
  opts?: { terminal?: boolean },
): Promise<CriticGateDecision> {
  if (taskIntent !== 'execute') {
    state.lastCriticReceipt = buildCriticSkipReceipt(
      'non_execute',
      `Diff critic skipped — task intent is ${taskIntent}, not execute`,
    );
    state.onThought?.('[Diff critic: skipped — non_execute]');
    return 'allow';
  }
  if (!isDiffCriticEnabled()) {
    state.lastCriticReceipt = buildCriticSkipReceipt(
      'disabled',
      'Diff critic skipped — BABEL_DIFF_CRITIC disabled (or not headless/CI)',
    );
    state.onThought?.('[Diff critic: skipped — disabled]');
    return 'allow';
  }
  if (!hasAnyWrites(state.toolCallLog)) {
    state.lastCriticReceipt = buildCriticSkipReceipt(
      'no_writes',
      'Diff critic skipped — no successful file mutations in tool log',
    );
    state.onThought?.('[Diff critic: skipped — no_writes]');
    return 'allow';
  }

  try {
    const mutationTargets = mutationTargetsFromLog(state.toolCallLog);
    const collected = collectWorkspacePatch(state.projectRoot, { mutationTargets });

    const modelId = resolveDiffCriticModel();
    const flashResolved = resolveOrCreateCriticRunner(
      modelId,
      state.criticRunner,
      state.resolveDeliberationRunner,
    );
    state.criticRunner = flashResolved.cache;
    const runner = flashResolved.runner;

    const proModelId = resolveDiffCriticProModel();
    const sweTier = isSweCriticTierEnabled() || isSweChatProfileEnabled();
    state.onThought?.('[Diff critic: reviewing patch vs task…]');

    const session = {
      cancelled: state.cancelled,
      abortController: state.abortController,
      timeoutMs: state.turnTimeoutMs,
    };

    const verdict = await runDiffCritic(
      {
        task: state.task,
        patch: collected.text,
        ...(state.lastVerifierReceipt
          ? { verifierReceipt: state.lastVerifierReceipt }
          : {}),
        proposedAnswer: answer,
        changedFiles:
          collected.files.length > 0
            ? collected.files
            : mutationTargets.map((t) => t.replace(/\\/g, '/')),
      },
      async (prompt, systemPrompt) => {
        const text = await executeCriticWithTimeout(
          runner,
          prompt,
          systemPrompt,
          session,
        );
        state.trackRunnerUsage(runner);
        return text;
      },
      {
        model: modelId,
        sweTier,
        proModel: proModelId,
        // Strict classes: red/missing local tests demote critic pass; tighter symbols
        requireGreenVerifier: sweTier,
        strictSymbolCoverage: sweTier,
        invokePro: async (prompt, systemPrompt) => {
          const proResolved = resolveOrCreateCriticProRunner(
            proModelId,
            state.criticProRunner,
            () =>
              resolveOrCreateCriticRunner(
                resolveDiffCriticModel(),
                state.criticRunner,
                state.resolveDeliberationRunner,
              ).runner,
          );
          state.criticProRunner = proResolved.cache;
          const proRunner = proResolved.runner;
          const text = await executeCriticWithTimeout(
            proRunner,
            prompt,
            systemPrompt,
            session,
          );
          state.trackRunnerUsage(proRunner);
          return text;
        },
      },
    );

    state.lastCriticReceipt = verdict;
    state.onThought?.(
      `[Diff critic: ${verdict.verdict}${verdict.reasons[0] ? ` — ${verdict.reasons[0].slice(0, 120)}` : ''}]`,
    );

    const gate = decideDiffCriticGate(
      verdict.verdict,
      state.criticStrikes,
      MAX_CRITIC_STRIKES,
      opts,
    );
    state.criticStrikes = gate.strikesAfter;

    if (gate.decision === 'allow') return 'allow';

    if (gate.decision === 'reject') {
      state.conversation.push({ role: 'assistant', content: answer });
      state.conversation.push({
        role: 'user',
        content: buildDiffCriticRejectionMessage(verdict),
      });
      return 'reject';
    }

    if (gate.reason) {
      state.lastCriticReceipt = {
        ...verdict,
        reasons: [...verdict.reasons, gate.reason],
      };
    }
    return 'block';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastCriticReceipt = {
      verdict: 'skip',
      reasons: [message],
      confidence: 0,
      skippedReason: 'error',
    };
    state.onThought?.(`[Diff critic: skipped — ${message.slice(0, 120)}]`);
    return 'allow';
  }
}

export interface MidLoopCriticState {
  toolCallLog: CriticToolLogEntry[];
  conversation: ChatMessage[];
  projectRoot: string;
  task: string;
  midLoopCriticFired: boolean;
  lastCriticReceipt: DiffCriticVerdict | null;
  criticStrikes: number;
  restrictToolsNextTurn: boolean;
  onThought?: ((msg: string) => void) | undefined;
}

/** Mid-loop cheap heuristic critic after first mutation. Mutates state. */
export function maybeInjectMidLoopHeuristicCritic(
  state: MidLoopCriticState,
  taskIntent: 'execute' | 'explain',
): void {
  if (taskIntent !== 'execute') return;
  if (!isDiffCriticEnabled()) return;
  if (state.midLoopCriticFired) return;
  if (!hasAnyWrites(state.toolCallLog)) return;

  try {
    const mutationTargets = mutationTargetsFromLog(state.toolCallLog);
    const collected = collectWorkspacePatch(state.projectRoot, { mutationTargets });
    if (!collected.text.trim()) return;

    const heuristic = runHeuristicDiffCritic(state.task, collected.text);
    if (!heuristic || heuristic.verdict !== 'reject') return;

    state.midLoopCriticFired = true;
    state.lastCriticReceipt = heuristic;
    state.criticStrikes = Math.max(state.criticStrikes, 1);
    state.restrictToolsNextTurn = true;
    state.conversation.push({
      role: 'user',
      content: [
        'MID-LOOP DIFF CRITIC (heuristic) rejected the current patch localization:',
        ...heuristic.reasons.map((r, i) => `  ${i + 1}. ${r}`),
        '',
        'Do not keep exploring-only. Re-open the defining file for the named API,',
        'fix the correct symbols, re-run the verifier, then continue.',
      ].join('\n'),
    });
    state.onThought?.(
      `[Mid-loop critic: reject — ${(heuristic.reasons[0] ?? '').slice(0, 100)}]`,
    );
  } catch {
    // fail-open mid-loop
  }
}

export function formatBudgetKillAnswer(
  reason: string,
  toolCallLog: CriticToolLogEntry[],
  criticVerdict: DiffCriticVerdict['verdict'] | null | undefined,
): string {
  return formatBudgetExceededAnswer(reason, {
    hadWrites: hasAnyWrites(toolCallLog),
    criticVerdict: criticVerdict ?? null,
  });
}

export { isDiffCriticEnabled };

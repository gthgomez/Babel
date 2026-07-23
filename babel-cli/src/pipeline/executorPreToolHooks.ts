import type { ToolCallRequest } from '../localTools.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { EvidenceBundle } from '../evidence.js';
import type { ExecutorLoopResult } from './executorLoopTypes.js';
import {
  runPreToolUseHooks,
  type RuntimeHookTraceEvent,
} from '../runtime/hooks.js';
import { resolveExecutionProfile } from '../config/executionProfiles.js';
import { getBenchmarkRuntimeInventoryForProfile } from './benchmarkRuntime.js';
import { normalizeShellCommandForComparison } from './benchmarkTasks.js';
import {
  buildExecutorTurnPromptLegacy,
  buildHaltReport,
  formatHistoryEntry,
  getTarget,
} from '../stages/executorHelpers.js';
import { emitRuntimeEvent, log, logDetail } from './logging.js';
import { writeValidatedExecutionReport } from './executionReports.js';

// ── Result type ───────────────────────────────────────────────────────────────

export type PreToolHookResult =
  | { kind: 'return'; result: ExecutorLoopResult }
  | {
      kind: 'continue';
      executionHistory: string;
      blockedToolCapabilityRecoveryCount: number;
    }
  | { kind: 'ok'; req: ToolCallRequest };

// ── PersistExecutorContext callback type ──────────────────────────────────────

export type PersistExecutorContext = (
  status: 'ready_for_next_turn' | 'after_tool_call' | 'terminal',
  nextTurnPrompt: string,
  details?: { terminalStatus?: string; haltTag?: string; condition?: string },
) => void;

// ── Extracted pre-tool-use hooks block ────────────────────────────────────────

/**
 * Apply pre-tool-use hooks for shell_exec / test_run commands.
 *
 * Handles three outcomes:
 * 1. **Rewrite** — the hook replaced the command (e.g. generic → profile-specific).
 *    Returns `{ kind: 'ok', req }` with the rewritten request.
 * 2. **Blocked** — the tool capability is unavailable.
 *    If the recovery budget is not exceeded: returns `{ kind: 'continue', ... }`
 *    with updated `executionHistory` and `blockedToolCapabilityRecoveryCount`.
 *    The caller must update its local variables and call `persistExecutorContext`
 *    before continuing the loop.
 *    If the budget IS exceeded: builds a terminal halt report, persists the
 *    executor context, writes the execution report, logs, and returns
 *    `{ kind: 'return', result }`. The caller should return immediately.
 * 3. **Pass-through** — not a shell command, or no hook intervention.
 *    Returns `{ kind: 'ok', req }` unchanged.
 */
export function applyPreToolUseHooks(
  req: ToolCallRequest,
  stepNum: number,
  rawTask: string,
  executionHistory: string,
  baseContext: string,
  fileReadCache: Map<string, string>,
  toolCallLog: ToolCallLog[],
  reportWarnings: string[],
  runtimeHookTraceEvents: RuntimeHookTraceEvent[],
  blockedToolCapabilityRecoveryCount: number,
  maxBlockedToolCapabilityRecoveries: number,
  evidence: EvidenceBundle,
  turnPrompt: string,
  persistExecutorContext: PersistExecutorContext,
): PreToolHookResult {
  // Only apply hooks for shell commands
  if (req.tool !== 'shell_exec' && req.tool !== 'test_run') {
    return { kind: 'ok', req };
  }

  const executionProfileName = resolveExecutionProfile(
    process.env['BABEL_EXECUTION_PROFILE'],
  ).name;
  const preToolHookResult = runPreToolUseHooks({
    request: req,
    rawTask,
    executionProfileName,
    runtimeInventory: getBenchmarkRuntimeInventoryForProfile(executionProfileName),
  });
  runtimeHookTraceEvents.push(...preToolHookResult.traces);

  // ── Rewrite case: command was modified by hooks ─────────────────────────
  if (
    !preToolHookResult.blocked &&
    (preToolHookResult.request.tool === 'shell_exec' ||
      preToolHookResult.request.tool === 'test_run') &&
    normalizeShellCommandForComparison(preToolHookResult.request.command) !==
      normalizeShellCommandForComparison(req.command)
  ) {
    const warning =
      `[TOOL_CAPABILITY_REWRITE] Step ${stepNum} ${req.tool} rewrote generic command ` +
      `"${req.command}" to "${preToolHookResult.request.command}".`;
    reportWarnings.push(warning);
    logDetail(warning);
    emitRuntimeEvent('policy.decision', {
      hook_id: 'tool_capability.pre_tool_use',
      decision: 'rewrite',
      tool: req.tool,
      original_command: req.command,
      replacement_command: preToolHookResult.request.command,
    });
    return { kind: 'ok', req: preToolHookResult.request };
  }

  // ── Blocked case: capability not available ──────────────────────────────
  if (preToolHookResult.blocked) {
    blockedToolCapabilityRecoveryCount += 1;
    const capabilityFeedback =
      preToolHookResult.message ?? '[TOOL_CAPABILITY_BROKER] Tool capability blocked.';
    const entry: ToolCallLog = {
      step: stepNum,
      tool: req.tool,
      target: getTarget(req),
      exit_code: 126,
      stdout: '(blocked before execution)',
      stderr: capabilityFeedback,
      verified: false,
    };
    toolCallLog.push(entry);

    const warning =
      `[TOOL_CAPABILITY_BLOCKED] Step ${stepNum} ${req.tool} blocked before execution; ` +
      `attempt ${blockedToolCapabilityRecoveryCount}/${maxBlockedToolCapabilityRecoveries}.`;
    reportWarnings.push(warning);
    logDetail(warning);
    emitRuntimeEvent('policy.decision', {
      hook_id: 'tool_capability.pre_tool_use',
      decision: 'block',
      tool: req.tool,
      command: req.command,
      message: capabilityFeedback,
    });

    executionHistory +=
      (executionHistory ? '\n\n' : '') +
      formatHistoryEntry(entry) +
      '\n\n--- TOOL CAPABILITY UNAVAILABLE ---\n' +
      'Do not retry a generic inspection command. Use the task-specific capability replacement if available, ' +
      'choose a source-only route, or halt with STEP_VERIFICATION_FAIL if the required runtime capability is missing.';

    // ── Budget exceeded: terminal halt ────────────────────────────────────
    if (blockedToolCapabilityRecoveryCount > maxBlockedToolCapabilityRecoveries) {
      const report = buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        stepNum,
        capabilityFeedback,
      );
      persistExecutorContext('terminal', turnPrompt, {
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: capabilityFeedback,
      });
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log(`  Executor: EXECUTION_HALTED [TOOL_CAPABILITY_BLOCKED] at step ${stepNum}`);
      return {
        kind: 'return',
        result: {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: capabilityFeedback,
        },
      };
    }

    // ── Budget OK: let caller persist context and continue ────────────────
    return {
      kind: 'continue',
      executionHistory,
      blockedToolCapabilityRecoveryCount,
    };
  }

  // ── Not blocked, not rewritten — pass through ───────────────────────────
  return { kind: 'ok', req };
}

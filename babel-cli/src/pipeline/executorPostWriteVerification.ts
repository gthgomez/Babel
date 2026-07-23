import { executeTool, DRY_RUN, type ToolCallRequest } from '../localTools.js';
import { EvidenceBundle } from '../evidence.js';
import { verifySuccessfulTextWriteTarget } from '../stages/verification.js';
import { getDeterministicSimpleRepairWrite } from '../stages/simpleArtifactFallback.js';
import {
  buildHaltReport,
  buildExecutorTurnPromptLegacy,
  canonicalizeExecutorTargetForLog,
  formatHistoryEntry,
  getExecutorProjectRoot,
} from '../stages/executorHelpers.js';
import { writeValidatedExecutionReport } from './executionReports.js';
import { BABEL_ROOT } from './paths.js';
import { log, logDetail } from './logging.js';
import type { ExecutorLoopResult } from './executorLoopTypes.js';
import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public result type
// ─────────────────────────────────────────────────────────────────────────────

export type PostWriteVerificationResult =
  | { kind: 'return'; result: ExecutorLoopResult }
  | { kind: 'continue'; executionHistory: string }
  | { kind: 'ok' };

// ─────────────────────────────────────────────────────────────────────────────
// Post-write verification and deterministic repair
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a successful file_write (exit_code === 0), verify that the written
 * content matches what was requested. If verification fails, attempt a
 * deterministic simple repair. If the repair succeeds, continue the loop.
 * If it fails, halt.
 *
 * Returns one of:
 *   - `{ kind: 'ok' }` — verification passed, no action needed
 *   - `{ kind: 'continue', executionHistory }` — repair was applied and
 *     verified; caller should update executionHistory and `continue`
 *   - `{ kind: 'return', result }` — caller should `return result`
 */
export async function verifyAndRepairFileWrite(
  req: ToolCallRequest,
  entry: ToolCallLog,
  stepNum: number,
  approvedPlan: SwePlan,
  rawTask: string,
  toolCallLog: ToolCallLog[],
  reportWarnings: string[],
  turnPrompt: string,
  evidence: EvidenceBundle,
  executionHistory: string,
  baseContext: string,
  fileReadCache: Map<string, string>,
  persistExecutorContext: (
    status: 'ready_for_next_turn' | 'after_tool_call' | 'terminal',
    nextTurnPrompt: string,
    details?: { terminalStatus?: string; haltTag?: string; condition?: string },
  ) => Promise<void>,
  maybeCompleteBoundedWriteTask: (nextTurnPrompt: string) => Promise<ExecutorLoopResult | null>,
): Promise<PostWriteVerificationResult> {
  // Guard: only verify actual file_write in non-dry-run mode
  if (DRY_RUN || req.tool !== 'file_write') {
    return { kind: 'ok' };
  }

  const writeVerificationFailure = verifySuccessfulTextWriteTarget(
    String(req.path ?? ''),
    getExecutorProjectRoot(),
    rawTask,
  );

  // Verification passed — nothing to do
  if (!writeVerificationFailure) {
    return { kind: 'ok' };
  }

  // ── Verification failed, try deterministic repair ──

  const repairWrite = getDeterministicSimpleRepairWrite(
    approvedPlan,
    rawTask,
    String(req.path ?? ''),
  );

  if (!repairWrite) {
    // No repair available — halt
    const report = buildHaltReport(
      toolCallLog,
      'STEP_VERIFICATION_FAIL',
      stepNum,
      writeVerificationFailure,
    );
    await persistExecutorContext('terminal', turnPrompt, {
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
      condition: writeVerificationFailure,
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
    return {
      kind: 'return',
      result: {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: writeVerificationFailure,
      },
    };
  }

  // ── Execute the deterministic repair ──

  const repairStepNum = toolCallLog.length + 1;
  const warning =
    `[EXECUTOR_DETERMINISTIC_SIMPLE_REPAIR] Recovered invalid bounded file_write output: ` +
    `${repairWrite.reason}. Original failure: ${writeVerificationFailure}`;
  reportWarnings.push(warning);
  logDetail(warning);

  const repairResult = await executeTool(
    {
      tool: 'file_write',
      path: repairWrite.target,
      content: repairWrite.content,
    },
    {
      agentId: 'executor',
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT,
    },
  );

  const repairEntry: ToolCallLog = {
    step: repairStepNum,
    tool: 'file_write',
    target: canonicalizeExecutorTargetForLog(repairWrite.target, 'file_write'),
    exit_code: repairResult.exit_code,
    stdout: repairResult.stdout,
    stderr: repairResult.stderr,
    ...(repairResult.denial ? { denial: repairResult.denial } : {}),
    ...(repairResult.mcp_lifecycle ? { mcp_lifecycle: repairResult.mcp_lifecycle } : {}),
    ...(repairResult.checkpoint_ids ? { checkpoint_ids: repairResult.checkpoint_ids } : {}),
    verified: repairResult.exit_code === 0,
  };
  toolCallLog.push(repairEntry);

  // ── Verify the repair ──

  const repairVerificationFailure =
    repairResult.exit_code === 0
      ? verifySuccessfulTextWriteTarget(
          repairWrite.target,
          getExecutorProjectRoot(),
          rawTask,
        )
      : `Deterministic repair file_write for "${repairWrite.target}" exited with code ${repairResult.exit_code}. ` +
        `stderr: ${repairResult.stderr.slice(0, 200)}`;

  if (repairVerificationFailure) {
    // Repair failed — halt
    const report = buildHaltReport(
      toolCallLog,
      'STEP_VERIFICATION_FAIL',
      repairStepNum,
      repairVerificationFailure,
    );
    await persistExecutorContext('terminal', turnPrompt, {
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
      condition: repairVerificationFailure,
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${repairStepNum}`);
    return {
      kind: 'return',
      result: {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: repairVerificationFailure,
      },
    };
  }

  // ── Repair succeeded: update history and attempt bounded-task completion ──

  executionHistory +=
    (executionHistory ? '\n\n' : '') +
    [formatHistoryEntry(entry), formatHistoryEntry(repairEntry)].join('\n\n');
  const nextTurnAfterRepair = buildExecutorTurnPromptLegacy(
    baseContext,
    executionHistory,
    toolCallLog.length,
    fileReadCache,
  );
  await persistExecutorContext('after_tool_call', nextTurnAfterRepair);

  const deterministicCompletion = await maybeCompleteBoundedWriteTask(nextTurnAfterRepair);
  if (deterministicCompletion) {
    return { kind: 'return', result: deterministicCompletion };
  }

  return { kind: 'continue', executionHistory };
}

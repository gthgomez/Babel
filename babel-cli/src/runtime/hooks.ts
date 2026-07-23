import type { ToolCallRequest } from '../localTools.js';
import type { BenchmarkRuntimeInventory } from '../config/benchmarkContainer.js';
import type { ExecutionProfileName } from '../config/executionProfiles.js';
import {
  formatToolCapabilityResolutionForFeedback,
  resolveToolCapabilityForCommand,
} from '../config/toolCapabilities.js';
import {
  verifyBenchmarkPreCompleteContract,
  type BenchmarkVerificationResult,
} from '../stages/benchmarkVerification.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import { getAllowedShellCommands } from '../sandbox.js';

export type RuntimeHookEvent =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'BeforeComplete'
  | 'SessionEnd';
export type RuntimeHookDecision = 'allow' | 'rewrite' | 'block';

export interface RuntimeHookTraceEvent {
  hook_id: string;
  event: RuntimeHookEvent;
  decision: RuntimeHookDecision;
  message: string;
  details?: Record<string, unknown>;
}

export interface PreToolUseHookInput {
  request: ToolCallRequest;
  rawTask: string;
  executionProfileName: ExecutionProfileName;
  runtimeInventory?: BenchmarkRuntimeInventory | null;
}

export interface PreToolUseHookResult {
  request: ToolCallRequest;
  traces: RuntimeHookTraceEvent[];
  blocked: boolean;
  message: string | null;
}

export interface BeforeCompleteHookInput {
  rawTask: string;
  toolCallLog: readonly ToolCallLog[];
}

export interface BeforeCompleteHookResult {
  traces: RuntimeHookTraceEvent[];
  blocked: boolean;
  message: string | null;
  benchmarkVerification: BenchmarkVerificationResult | null;
}

function replaceShellCommand(req: ToolCallRequest, command: string): ToolCallRequest {
  if (req.tool === 'shell_exec' || req.tool === 'test_run') {
    return {
      ...req,
      command,
    };
  }
  return req;
}

export function runPreToolUseHooks(input: PreToolUseHookInput): PreToolUseHookResult {
  const traces: RuntimeHookTraceEvent[] = [];
  const req = input.request;
  if (req.tool !== 'shell_exec' && req.tool !== 'test_run') {
    return { request: req, traces, blocked: false, message: null };
  }

  const resolution = resolveToolCapabilityForCommand(req.command, {
    rawTask: input.rawTask,
    executionProfileName: input.executionProfileName,
    allowedCommandBases: getAllowedShellCommands(input.executionProfileName),
    runtimeInventory: input.runtimeInventory,
  });

  if (resolution.status === 'none') {
    return { request: req, traces, blocked: false, message: null };
  }

  const feedback = formatToolCapabilityResolutionForFeedback(resolution);
  if (resolution.status === 'suggest_replacement' && resolution.replacementCommand) {
    traces.push({
      hook_id: 'tool_capability.pre_tool_use',
      event: 'PreToolUse',
      decision: 'rewrite',
      message: feedback,
      details: {
        capability_id: resolution.capabilityId,
        original_command: resolution.originalCommand,
        replacement_command: resolution.replacementCommand,
      },
    });
    return {
      request: replaceShellCommand(req, resolution.replacementCommand),
      traces,
      blocked: false,
      message: feedback,
    };
  }

  traces.push({
    hook_id: 'tool_capability.pre_tool_use',
    event: 'PreToolUse',
    decision: 'block',
    message: feedback,
    details: {
      capability_id: resolution.capabilityId,
      original_command: resolution.originalCommand,
      missing_requirements: [...resolution.missingRequirements],
    },
  });
  return {
    request: req,
    traces,
    blocked: true,
    message: feedback,
  };
}

export function runBeforeCompleteHooks(input: BeforeCompleteHookInput): BeforeCompleteHookResult {
  const benchmarkVerification = verifyBenchmarkPreCompleteContract(
    input.rawTask,
    input.toolCallLog,
  );
  if (!benchmarkVerification) {
    return {
      traces: [],
      blocked: false,
      message: null,
      benchmarkVerification,
    };
  }

  const trace: RuntimeHookTraceEvent = {
    hook_id: 'benchmark_verification.before_complete',
    event: 'BeforeComplete',
    decision: benchmarkVerification.passed ? 'allow' : 'block',
    message: benchmarkVerification.message,
    details: {
      contract_id: benchmarkVerification.contractId,
      ...(benchmarkVerification.failureCategory
        ? { failure_category: benchmarkVerification.failureCategory }
        : {}),
    },
  };

  return {
    traces: [trace],
    blocked: !benchmarkVerification.passed,
    message: benchmarkVerification.passed ? null : benchmarkVerification.message,
    benchmarkVerification,
  };
}

// ─── Session-level hooks (Phase 3A) ──────────────────────────────────────

export interface SessionStartHookInput {
  rawTask: string;
  projectRoot?: string;
  executionProfileName?: ExecutionProfileName;
}

export interface SessionStartHookResult {
  traces: RuntimeHookTraceEvent[];
  blocked: boolean;
  message: string | null;
  injectedContext?: string;
}

export function runSessionStartHooks(input: SessionStartHookInput): SessionStartHookResult {
  // Intentional no-op placeholder for the future plugin system.
  // This is a designed extension point -- not forgotten -- for registering
  // SessionStart hooks to inject context or set policies before the
  // pipeline begins.
  return {
    traces: [],
    blocked: false,
    message: null,
  };
}

export interface PostToolUseHookInput {
  request: ToolCallRequest;
  result: { exit_code: number; stdout: string; stderr: string };
  rawTask: string;
  executionProfileName?: ExecutionProfileName;
}

export interface PostToolUseHookResult {
  traces: RuntimeHookTraceEvent[];
  blocked: boolean;
  message: string | null;
}

export function runPostToolUseHooks(input: PostToolUseHookInput): PostToolUseHookResult {
  // PostToolUse hooks run after a tool completes.
  // They can audit results, trigger side effects (e.g., memory extraction),
  // or block further execution based on tool output patterns.
  const traces: RuntimeHookTraceEvent[] = [];

  // Detect policy-significant tool outcomes
  if (
    input.result.exit_code !== 0 &&
    (input.request.tool === 'shell_exec' || input.request.tool === 'test_run')
  ) {
    traces.push({
      hook_id: 'post_tool_use.command_failure',
      event: 'PostToolUse',
      decision: 'allow',
      message: `Command failed with exit code ${input.result.exit_code}: ${String(input.request.command ?? '').slice(0, 80)}`,
      details: {
        tool: input.request.tool,
        exit_code: input.result.exit_code,
      },
    });
  }

  return {
    traces,
    blocked: false,
    message: null,
  };
}

export interface SessionEndHookInput {
  rawTask: string;
  terminalStatus: string;
  runDir: string;
}

export interface SessionEndHookResult {
  traces: RuntimeHookTraceEvent[];
}

export function runSessionEndHooks(input: SessionEndHookInput): SessionEndHookResult {
  // SessionEnd hooks run after pipeline completion.
  // They can trigger cleanup, memory extraction, or post-run notifications.
  return {
    traces: [
      {
        hook_id: 'session_end',
        event: 'SessionEnd',
        decision: 'allow',
        message: `Run completed with status: ${input.terminalStatus}`,
        details: { runDir: input.runDir },
      },
    ],
  };
}

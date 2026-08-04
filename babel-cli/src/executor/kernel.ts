import { randomUUID } from "node:crypto";
import type {
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "../localTools.js";
import { executeActionWithPolicy } from "../agent/toolExecutor.js";
import type { AgentAction } from "../agent/actions.js";

import {
  createChatEngineServices,
  type ChatEngineServices,
} from "../agent/chatEngineServices.js";
import {
  evaluateExecuteCompletionHonesty,
  type CompletionGateRejectReason,
  type GateToolLogEntry,
  type VerifierReceipt,
} from "../agent/completionGatePolicy.js";
import type { TerminalOutcome } from "../schemas/agentContracts.js";
import {
  evaluateCompletionEvidence,
  evaluateCompletionEvidenceSync,
  type CompletionEvidenceEvaluation,
} from "../evidence/completionEvidence.js";
import type { AcceptanceContract } from "../evidence/acceptanceContracts.js";
import type { EvidenceGraph } from "../evidence/evidenceGraph.js";
import {
  EXECUTOR_CONTRACT_VERSION,
  EXECUTOR_KERNEL_VERSION,
  type BabelMode,
  type CompletionDecision,
  type ModePolicy,
  modePolicyFor,
} from "./contracts.js";

/** Input used by the shared completion authority. */
export interface ExecutorCompletionInput {
  mode: BabelMode;
  requestedOutcome: TerminalOutcome | "PLAN_COMPLETE";
  hasWrite: boolean;
  verificationPolicy: "none" | "required" | "strict";
  lastVerifierReceipt?: VerifierReceipt | null;
  toolCallLog: GateToolLogEntry[];
  proof?: { compliant: boolean; errors?: string[] };
  workspaceRevision?: CompletionDecision["workspaceRevision"];
  evidenceRefs?: string[];
}

/** Shared execution substrate consumed by Chat, Plan, Deep, and protocol adapters. */
export interface ExecutorKernel {
  readonly version: typeof EXECUTOR_KERNEL_VERSION;
  readonly contractVersion: typeof EXECUTOR_CONTRACT_VERSION;
  readonly policy: ModePolicy;
  readonly services: ChatEngineServices;
  readonly completion: {
    decide(input: ExecutorCompletionInput): CompletionDecision;
    evaluateEvidence(input: {
      contract: AcceptanceContract;
      graph: EvidenceGraph;
      projectRoot: string;
    }): Promise<CompletionEvidenceEvaluation>;
    /** Sync twin for Chat finalize (same authority as evaluateEvidence). */
    evaluateEvidenceSync(input: {
      contract: AcceptanceContract;
      graph: EvidenceGraph;
      projectRoot: string;
    }): CompletionEvidenceEvaluation;
  };
  readonly tools: {
    execute(
      request: ToolCallRequest,
      context: ToolContext,
    ): Promise<ToolResult>;
  };
  readonly ids: {
    operation(): string;
    mutationBatch(): string;
  };
}

function rejectionReason(reason: CompletionGateRejectReason): string {
  return reason === null ? "accepted" : reason;
}

function requestToAgentAction(request: ToolCallRequest): AgentAction {
  switch (request.tool) {
    case "file_read":
      return { type: "read_file", path: String(request.path ?? "") };
    case "directory_list":
      return { type: "list_dir", path: String(request.path ?? ".") };
    case "grep":
      return {
        type: "grep",
        pattern: String(request.pattern ?? ""),
        ...(request.path ? { path: request.path } : {}),
      };
    case "glob":
      return { type: "glob", pattern: String(request.pattern ?? "") };
    case "file_write":
      return {
        type: "write_file",
        path: String(request.path ?? ""),
        content: String(request.content ?? ""),
      };
    case "shell_exec":
      return {
        type: "run_command",
        command: String(request.command ?? ""),
        ...(request.working_directory
          ? { cwd: request.working_directory }
          : {}),
      };
    case "test_run":
      return {
        type: "test_run",
        command: String(request.command ?? ""),
        ...(request.working_directory
          ? { cwd: request.working_directory }
          : {}),
        ...(request.timeout_seconds !== undefined
          ? { timeout_seconds: request.timeout_seconds }
          : {}),
      };
    case "workspace_map":
      return {
        type: "workspace_map",
        ...(request.max_depth !== undefined
          ? { max_depth: request.max_depth }
          : {}),
        ...(request.max_files !== undefined
          ? { max_files: request.max_files }
          : {}),
      };
    case "git_context":
      return {
        type: "git_context",
        ...(request.format ? { format: request.format } : {}),
        ...(request.path ? { path: request.path } : {}),
        ...(request.max_lines !== undefined
          ? { max_lines: request.max_lines }
          : {}),
      };
    default:
      throw new Error(
        `Kernel cannot execute unsupported tool request: ${request.tool}`,
      );
  }
}

function decideCompletion(input: ExecutorCompletionInput): CompletionDecision {
  const evidenceRefs = input.evidenceRefs ?? [];

  if (input.mode === "plan" || input.requestedOutcome === "PLAN_COMPLETE") {
    const planCompletion =
      input.mode === "plan" && input.requestedOutcome === "PLAN_COMPLETE";
    const rejectedExecutorCompletion =
      input.mode === "plan" &&
      (input.requestedOutcome === "VERIFIED_COMPLETE" ||
        input.requestedOutcome === "UNVERIFIED_PATCH");
    return {
      requestedOutcome: input.requestedOutcome,
      finalOutcome:
        planCompletion || rejectedExecutorCompletion
          ? "PLAN_COMPLETE"
          : input.requestedOutcome,
      allowed: planCompletion,
      reason: planCompletion
        ? "plan_artifact_complete"
        : rejectedExecutorCompletion
          ? "executor_plan_mismatch"
          : "plan_terminal_preserved",
      ...(input.workspaceRevision
        ? { workspaceRevision: input.workspaceRevision }
        : {}),
      evidenceRefs,
      policyVersion: EXECUTOR_CONTRACT_VERSION,
    };
  }

  const gate = evaluateExecuteCompletionHonesty({
    hasWrite: input.hasWrite,
    policy: input.verificationPolicy,
    lastVerifierReceipt: input.lastVerifierReceipt,
    toolCallLog: input.toolCallLog,
  });
  const verified = input.proof?.compliant === true && gate.allow;
  const finalOutcome: TerminalOutcome =
    input.requestedOutcome === "VERIFIED_COMPLETE" && verified
      ? "VERIFIED_COMPLETE"
      : input.requestedOutcome === "VERIFIED_COMPLETE"
        ? "UNVERIFIED_PATCH"
        : input.requestedOutcome;

  return {
    requestedOutcome: input.requestedOutcome,
    finalOutcome,
    allowed: input.requestedOutcome !== "VERIFIED_COMPLETE" || verified,
    reason: verified
      ? "proof_carrying_completion_accepted"
      : input.requestedOutcome === "VERIFIED_COMPLETE"
        ? `completion_downgraded:${input.proof && !input.proof.compliant ? "evidence_incomplete" : rejectionReason(gate.reason)}`
        : "non_verified_terminal_preserved",
    ...(input.workspaceRevision
      ? { workspaceRevision: input.workspaceRevision }
      : {}),
    evidenceRefs,
    policyVersion: EXECUTOR_CONTRACT_VERSION,
  };
}

/** Create the mode-neutral executor substrate without selecting an orchestrator. */
export function createExecutorKernel(
  mode: BabelMode = "chat",
  services: ChatEngineServices = createChatEngineServices(),
): ExecutorKernel {
  return {
    version: EXECUTOR_KERNEL_VERSION,
    contractVersion: EXECUTOR_CONTRACT_VERSION,
    policy: modePolicyFor(mode),
    services,
    completion: {
      decide: decideCompletion,
      evaluateEvidence: evaluateCompletionEvidence,
      evaluateEvidenceSync: evaluateCompletionEvidenceSync,
    },
    tools: {
      async execute(request, context) {
        const result = await executeActionWithPolicy(
          requestToAgentAction(request),
          "workspace_write",
          context,
        );
        const last = result.results[result.results.length - 1];
        return {
          exit_code: last?.exit_code ?? 1,
          stdout: result.results.map((entry) => entry.stdout).join("\n"),
          stderr: result.results
            .map((entry) => entry.stderr)
            .filter(Boolean)
            .join("\n"),
        };
      },
    },
    ids: {
      operation: () => randomUUID(),
      mutationBatch: () => randomUUID(),
    },
  };
}

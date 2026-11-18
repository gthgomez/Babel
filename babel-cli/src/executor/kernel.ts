import { randomUUID } from "node:crypto";
import { evaluateCriterionCompletionV1 } from '../authority/criterionCompletion.js';
import type {
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "../localTools.js";
import { executeActionWithPolicy } from "../agent/toolExecutor.js";
import { evaluateGovernedIsolation } from '../config/benchmarkContainer.js';
import { getScopedExecutionProfile } from '../config/executionPolicySelection.js';
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
  type ExecutorCompletionInput,
  type ModePolicy,
  modePolicyFor,
} from "./contracts.js";
import {
  FINAL_REVISION_CONTRACT_VERSION,
  type FinalRevisionWitnessV1,
} from "../authority/finalRevision.js";

export type { ExecutorCompletionInput };

/** Kernel input for the shared final-revision (`final-revision-v1`) decision. */
export interface FinalRevisionCompletionInput {
  /** True when the turn claims the final tree is verified. */
  verifiedClaim: boolean;
  finalRevision: FinalRevisionWitnessV1;
}

/** Shared execution substrate consumed by Chat, Plan, Deep, and protocol adapters. */
export interface ExecutorKernel {
  readonly version: typeof EXECUTOR_KERNEL_VERSION;
  readonly contractVersion: typeof EXECUTOR_CONTRACT_VERSION;
  readonly policy: ModePolicy;
  readonly services: ChatEngineServices;
  readonly completion: {
    decide(input: ExecutorCompletionInput): CompletionDecision;
    /**
     * Shared final-revision authority for Chat and Deep. Never promotes a
     * stale witness to success and never edits or deletes user bytes.
     */
    decideFinalRevision(input: FinalRevisionCompletionInput): CompletionDecision;
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
      return { type: "list_dir", path: String(request.path ?? "."), ...(request.after !== undefined ? { after: request.after } : {}), ...(request.revision !== undefined ? { revision: request.revision } : {}) };
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
  const finalRevision = input.finalRevision ?? undefined;

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
    // A checked no-change conclusion is valid evidence only when it is not
    // claiming a patch; inspectable completion never certifies a mutation.
    ...(input.requestedOutcome !== 'VERIFIED_COMPLETE' ? { allowInspectedNoChange: true } : {}),
    policy: input.requestedOutcome === 'VERIFIED_COMPLETE' ? 'strict' : input.verificationPolicy,
    ...(input.requestedOutcome === 'VERIFIED_COMPLETE' || input.requiredVerifiers !== undefined
      ? { requiredVerifiers: input.requiredVerifiers ?? [] } : {}),
    ...(input.verifierOwner ? { verifierOwner: input.verifierOwner } : {}),
    currentWorkspaceRevisionHash: input.currentWorkspaceRevisionHash ?? null,
    ...(input.currentReceiptRevisionHashes !== undefined ? { currentReceiptRevisionHashes: input.currentReceiptRevisionHashes } : {}),
    lastVerifierReceipt: input.lastVerifierReceipt ?? null,
    toolCallLog: input.toolCallLog,
    requiredVerifierCommands: input.requiredVerifierCommands ?? null,
    executedVerifierLedger: input.executedVerifierLedger ?? null,
    verifierEvidenceErrors: input.verifierEvidenceErrors ?? null,
  });
  const acceptance = input.requestedOutcome === 'VERIFIED_COMPLETE'
    ? evaluateCriterionCompletionV1(input.acceptance) : undefined;
  const finalRevisionStale = finalRevision?.status === 'stale';
  const noChangeRequested = input.requestedOutcome === 'NO_CHANGE_REQUIRED';
  const noChangeProofRequired = noChangeRequested && input.finalRevisionRequired !== false;
  const noChangeUnproven = noChangeProofRequired && finalRevision?.status !== 'verified';
  const verified = input.proof?.compliant === true && gate.allow && acceptance?.verified === true &&
    !finalRevisionStale && !noChangeUnproven;
  const finalOutcome: TerminalOutcome =
    input.requestedOutcome === "VERIFIED_COMPLETE" && verified
      ? "VERIFIED_COMPLETE"
      : input.requestedOutcome === "VERIFIED_COMPLETE"
        ? "UNVERIFIED_PATCH"
        : noChangeUnproven
          ? "UNVERIFIED_PATCH"
          : input.requestedOutcome;
  const finalRevisionReason = noChangeUnproven
    ? `final_revision_${finalRevision?.status ?? 'unavailable'}:${finalRevision?.reason ?? 'no_current_bytes_proof'}`
    : "final_revision_stale";

  return {
    requestedOutcome: input.requestedOutcome,
    finalOutcome,
    allowed: noChangeUnproven || finalRevisionStale
      ? false
      : input.requestedOutcome !== "VERIFIED_COMPLETE" || verified,
    reason: verified
      ? "proof_carrying_completion_accepted"
      : noChangeUnproven || finalRevisionStale
        ? finalRevisionReason
        : input.requestedOutcome === "VERIFIED_COMPLETE"
        ? `completion_downgraded:${input.proof && !input.proof.compliant ? "evidence_incomplete" : !gate.allow ? rejectionReason(gate.reason) : `acceptance_${acceptance?.status.toLowerCase() ?? 'unknown'}`}`
        : "non_verified_terminal_preserved",
    ...(input.workspaceRevision
      ? { workspaceRevision: input.workspaceRevision }
      : {}),
    ...(finalRevision ? { finalRevision } : {}),
    ...(finalRevision?.stale_paths.length ? { stalePaths: [...finalRevision.stale_paths] } : {}),
    evidenceRefs,
    policyVersion: finalRevision
      ? `${EXECUTOR_CONTRACT_VERSION}+${FINAL_REVISION_CONTRACT_VERSION}`
      : EXECUTOR_CONTRACT_VERSION,
  };
}

/**
 * Revision-only decision for a host that has already derived the verifier
 * obligation. Deep finalization consumes it; Chat no-change publication uses
 * `decide()` with the same witness. A verified claim needs a verified witness;
 * every other claim remains explicitly `UNVERIFIED_PATCH` (never certified).
 */
function decideFinalRevisionCompletion(
  input: FinalRevisionCompletionInput,
): CompletionDecision {
  const stale = input.finalRevision.status === 'stale';
  const verified = input.finalRevision.status === 'verified';
  const requestedOutcome: TerminalOutcome = input.verifiedClaim ? 'VERIFIED_COMPLETE' : 'UNVERIFIED_PATCH';
  const finalOutcome: TerminalOutcome =
    requestedOutcome === 'VERIFIED_COMPLETE' && verified && !stale
      ? 'VERIFIED_COMPLETE'
      : requestedOutcome === 'VERIFIED_COMPLETE'
        ? 'UNVERIFIED_PATCH'
        : requestedOutcome;
  const reason = verified && !stale
    ? 'final_revision_verified'
    : stale
      ? `final_revision_stale:${input.finalRevision.reason ?? 'changed_bytes'}`
      : `final_revision_${input.finalRevision.status}:${input.finalRevision.reason ?? 'unproven'}`;
  return {
    requestedOutcome,
    finalOutcome,
    allowed: requestedOutcome !== 'VERIFIED_COMPLETE' || (verified && !stale),
    reason,
    finalRevision: input.finalRevision,
    ...(input.finalRevision.stale_paths.length ? { stalePaths: [...input.finalRevision.stale_paths] } : {}),
    evidenceRefs: [],
    policyVersion: `${EXECUTOR_CONTRACT_VERSION}+${FINAL_REVISION_CONTRACT_VERSION}`,
  };
}

const KERNEL_MUTATION_TOOLS = new Set([
  "file_write",
  "shell_exec",
  "test_run",
]);

/** Create the mode-neutral executor substrate without selecting an orchestrator. */
export function createExecutorKernel(
  mode: BabelMode = "chat",
  services: ChatEngineServices = createChatEngineServices(),
): ExecutorKernel {
  const policy = modePolicyFor(mode);
  return {
    version: EXECUTOR_KERNEL_VERSION,
    contractVersion: EXECUTOR_CONTRACT_VERSION,
    policy,
    services,
    completion: {
      decide: decideCompletion,
      decideFinalRevision: decideFinalRevisionCompletion,
      evaluateEvidence: evaluateCompletionEvidence,
      evaluateEvidenceSync: evaluateCompletionEvidenceSync,
    },
    tools: {
      async execute(request, context) {
        if (
          policy.mutationPolicy === "read_only" &&
          KERNEL_MUTATION_TOOLS.has(request.tool)
        ) {
          return {
            exit_code: 1,
            stdout: "",
            stderr: "plan_read_only: mutation tools are denied in Plan mode at the executor kernel boundary.",
          };
        }
        // The authority gate must see the same runtime boundary the sandbox
        // will enforce. Omitted facts mean unavailable, even with Docker ready.
        const isolation = evaluateGovernedIsolation(
          getScopedExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']),
          process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] ?? null,
        );
        const result = await executeActionWithPolicy(
          requestToAgentAction(request),
          "workspace_write",
          context,
          {
            mode,
            isolationRequired: isolation.kind !== 'host_profile',
            isolationAvailable: isolation.kind === 'docker',
            hostFallbackAllowed: isolation.kind === 'host_escalated' || isolation.kind === 'host_profile',
          },
        );
        const last = result.results[result.results.length - 1];
        return {
          exit_code: last?.exit_code ?? 1,
          stdout: result.results.map((entry) => entry.stdout).join("\n"),
          stderr: result.results
            .map((entry) => entry.stderr)
            .filter(Boolean)
            .join("\n"),
          ...(last?.directory_page ? { directory_page: last.directory_page } : {}),
        };
      },
    },
    ids: {
      operation: () => randomUUID(),
      mutationBatch: () => randomUUID(),
    },
  };
}

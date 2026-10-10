/**
 * apply_patch executor path — extracted from chatEngineActionExecutor.ts to
 * stay under the repo's 2,000-line file-size ratchet (packet D1).
 *
 * Hunks are applied in memory first by governedApplyPatch (transactional:
 * any failed hunk means nothing is written); each target file's new content
 * is dispatched through the same write_file policy gate as str_replace.
 */
import {
  governedApplyPatch,
  type GovernedApplyPatchResult,
} from "../governedMutations.js";
import { defaultToolExecutor } from "../toolExecutor.js";
import { resolveClassCGateDecision } from "../autonomyEnforcement.js";
import { recordMutationBatch, operationFingerprint } from "../sessionEvents.js";
import { assessMutationEffect } from "../mutationTools.js";
import { applyWorkingStateEvent } from "./workingState.js";
import { actualRecoveryEdit } from "./recoveryPlan.js";
import {
  noteChatWorkspaceMutation,
  countPatchStats,
  primaryPatchPath,
  invalidateVerifierLedger,
} from "../chatEngineSupport.js";
import { appendPatchRecovery } from "../patchRecovery.js";
import { chatActionToolName, type ChatToolAction } from "../chatToolDefinitions.js";
import type { ChatCallbacks } from "../chatEngineContracts.js";
import type { ChatEngineActionExecutorHost } from "../chatEngineContracts.js";
import { invalidateReadCacheForPath } from "./readWindow.js";
import {
  EDIT_REFLECTION_CAP_MARKER,
  formatEditReflectionCapSurface,
  formatEditReflectionNote,
  type EditReflectionTracker,
} from "./reflection.js";
import type { ToolContext } from "../../localTools.js";

export interface ApplyPatchActionContext {
  host: ChatEngineActionExecutorHost;
  /** The apply_patch action (pre-narrowed by the caller). */
  action: Extract<ChatToolAction, { type: "apply_patch" }>;
  patchText: string;
  toolContext: ToolContext;
  tool: string;
  target: string;
  toolId: number;
  meta: { index: number };
  ownerGeneration: number;
  dispatchTurnId: string | null;
  recoveredAuthorization: { allowed: boolean; message?: string };
  admittedThisAction: boolean;
  proposedEdit: { exactFingerprint: string } | null;
  callbacks: ChatCallbacks;
  /** Bounded reflection counter on failed edits — per file per turn (C2). */
  editReflection: EditReflectionTracker;
}

/**
 * Execute apply_patch through the governed mutation path. Returns the settled
 * action result; stale-submission settlement is delegated to the host.
 */
export async function executeGovernedApplyPatchAction(
  ctx: ApplyPatchActionContext,
): Promise<{ index: number; observation: string; stop?: boolean }> {
  const { host, action, patchText, toolContext, tool, target, toolId, meta } = ctx;
  const classC = resolveClassCGateDecision({
    executionProfile: host.executionProfile,
  });
  const gov: GovernedApplyPatchResult = await governedApplyPatch(
    { patch: patchText },
    {
      projectRoot: host.options.projectRoot,
      context: toolContext,
      preset: "workspace_write",
      executor: defaultToolExecutor,
      onDispatchAuthorized: () => ctx.recoveredAuthorization,
      onBeforeExecutorExecute: () => host.persistToolStartedAtExecutorDispatch(action, ctx.meta),
      ...(host.parity.authoritySession
        ? { authoritySession: host.parity.authoritySession }
        : {}),
      ...(classC === "allow" ? { onAskApproval: async () => true } : {}),
    },
  );

  // governedApplyPatch is a suspension point; a superseded submission
  // must not record a mutation batch or write the current task's log.
  if (!host.isSubmissionCurrent(ctx.ownerGeneration)) {
    return host.settleStaleActionResult(
      tool,
      target,
      meta.index,
      "parent submission superseded before the action settled",
    );
  }
  if (gov.mutationPaths && gov.mutationPaths.length > 0) {
    recordMutationBatch(
      host.parity.sessionEvents,
      ctx.dispatchTurnId ?? "unknown",
      {
        paths: gov.mutationPaths,
        pre_hash: Object.values(gov.preBatchHash ?? {}).join(","),
        post_hash: Object.values(gov.postBatchHash ?? {}).join(","),
        ...(gov.mutationReceipt
          ? {
              batch_id: gov.mutationReceipt.batchId,
              starting_revision: gov.mutationReceipt.startingRevision,
              ...(gov.mutationReceipt.endingRevision
                ? { ending_revision: gov.mutationReceipt.endingRevision }
                : {}),
              changed_bytes: gov.mutationReceipt.changedBytes,
              status: gov.mutationReceipt.status,
              pre_image_hashes: gov.mutationReceipt.preImageHashes,
              post_image_hashes: gov.mutationReceipt.postImageHashes,
            }
          : {}),
      },
    );
  }

  const patchEffect = assessMutationEffect({
    tool: "apply_patch",
    error: gov.error,
    exitCode: gov.exit_code,
    policyBlocked: gov.policyBlocked,
    mutationPaths: gov.mutationPaths,
    mutationReceipt: gov.mutationReceipt,
    effectTransaction: gov.effectTransaction,
    preDispatchNoEffect: gov.preDispatchNoEffect,
  });

  const effectPaths =
    gov.absolutePaths.length > 0 ? gov.absolutePaths : [primaryPatchPath(patchText)];
  for (const effectPath of effectPaths) {
    const effectKey = host.readCacheKey(effectPath);
    invalidateReadCacheForPath(host.readCache, effectKey);
    host.fullReadCounts.delete(effectKey);
  }
  if (patchEffect.status === "indeterminate") {
    invalidateVerifierLedger(host as never, patchEffect.reason);
  }

  const primaryPath = gov.absolutePaths[0] ?? primaryPatchPath(patchText);
  if (
    ctx.admittedThisAction &&
    ctx.proposedEdit &&
    patchEffect.status === "confirmed_no_change" &&
    host.isSubmissionCurrent(ctx.ownerGeneration)
  ) {
    host.workingState = applyWorkingStateEvent(host.workingState, {
      type: "recovery_proven_no_effect",
      fingerprint: ctx.proposedEdit.exactFingerprint,
    });
    host.persistRecoveryWorkingState();
  }
  if (gov.exit_code === 0 && patchEffect.status === "confirmed_change") {
    const { adds, dels } = countPatchStats(patchText);
    const edit = actualRecoveryEdit(action, host.options.projectRoot);
    host.workingState = applyWorkingStateEvent(host.workingState, {
      type: "mutation",
      path: primaryPath,
      fingerprint:
        edit?.exactFingerprint ?? operationFingerprint(chatActionToolName(action), action),
      ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
    });
    noteChatWorkspaceMutation(host as never);
    ctx.callbacks.onFileChanged?.(primaryPath, adds, dels, patchText);
    appendPatchRecovery(host.patchRecoveryPath ?? "", "apply_patch", primaryPath, patchText);
  }

  let patchObs = gov.observation;
  // C2: bounded reflection — failed-patch diagnostics already flow back to
  // the model; count the round per primary file per turn and cap retries.
  // A policy block is a gate decision, not an anchor failure.
  let patchStop: boolean | undefined;
  if (gov.exit_code !== 0 && !gov.policyBlocked) {
    const decision = ctx.editReflection.recordFailure(ctx.ownerGeneration, primaryPath);
    if (decision.capped) {
      patchObs = formatEditReflectionCapSurface(target, gov.observation);
      patchStop = true;
      host.policyEventLog.record({
        at_turn: host._turnIndex,
        kind: "edit_reflection_cap",
        detail:
          `rounds=${decision.round} file=${primaryPath} ` +
          `error=${(gov.error ?? "apply_patch failed").slice(0, 120)}`,
        tool,
      });
    } else {
      patchObs += `\n\n${formatEditReflectionNote(decision)}`;
    }
  }
  host.toolCallLog.push({
    tool,
    target,
    detail: patchStop
      ? EDIT_REFLECTION_CAP_MARKER
      : gov.exit_code === 0
        ? `applied (${patchEffect.status})`
        : patchEffect.status,
    ...(gov.exit_code !== 0 ? { error: gov.error ?? "apply_patch failed" } : {}),
    index: meta.index,
    exit_code: gov.exit_code,
    effect_status: patchEffect.status,
    ...(gov.mutationPaths && gov.mutationPaths.length > 0
      ? { mutation_paths: [...gov.mutationPaths] }
      : {}),
  });
  ctx.callbacks?.onToolComplete?.(
    toolId,
    gov.exit_code === 0
      ? "applied"
      : patchStop
        ? EDIT_REFLECTION_CAP_MARKER
        : gov.policyBlocked
          ? "blocked"
          : "error",
    gov.exit_code === 0 ? undefined : gov.error ?? "apply_patch failed",
    gov.exit_code,
  );
  if (gov.exit_code === 0) {
    const staticResult = await host.runPostEditStaticCheck(primaryPath);
    if (staticResult) patchObs += `\n\n### static_check ${target}\n${staticResult}`;
    if (!host.isSubmissionCurrent(ctx.ownerGeneration)) {
      return host.settleStaleActionResult(
        tool,
        target,
        meta.index,
        "parent submission superseded before the action settled",
      );
    }
    const tamperWarning = host.checkVerifierTamper(primaryPath);
    if (tamperWarning) patchObs += `\n\n### verifier_integrity\n${tamperWarning}`;
    // C2: a successful patch clears the file's reflection counter.
    ctx.editReflection.recordSuccess(ctx.ownerGeneration, primaryPath);
  }
  return {
    index: meta.index,
    observation: patchObs,
    ...(patchStop ? { stop: true as const } : {}),
  };
}

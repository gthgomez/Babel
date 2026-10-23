import type { ChatEngineActionExecutorHost } from './chatEngineContracts.js'
import type { ChatToolAction } from './chatToolDefinitions.js'
import type { ToolResult } from '../sandbox.js'
import { requireProjectRoot } from './chatExecutionScope.js'
import { captureAndRecordVerifierReceipt, resolveVerifierCacheIdentity } from './chatEngineVerifierAdapter.js'
import { mutationPathsFromSessionEvents } from '../evidence/chatRevisionBinding.js'
import { formatVerifierReceiptSummary, applyWorkingStateEvent } from './codingLoop/index.js'
import { ingestVerifierResult } from './codingLoop/chatBindings.js'
import { invalidateVerifierLedger } from './chatEngineSupport.js'
import { isFatalWindowsProcessExit } from './verifierFailFast.js'
import { makeFailureCapsule } from './taskContract.js'

/** One receipt and repair-state settlement path for foreground and completed background verifiers. */
export async function settleChatVerifierResult(input: {
  host: ChatEngineActionExecutorHost
  action: Extract<ChatToolAction, { type: 'run_command' | 'test_run' }>
  result: ToolResult
  target: string
  tool: string
  meta: { index: number; idempotencyKey?: string }
  ownerGeneration: number
  confirmedShellMutation: boolean
  obsParts: string[]
  cacheIdentity?: { key: string; cwd: string; envKey: string }
  canPublish?: () => boolean
  isOwnerCurrent?: () => boolean
}): Promise<{ index: number; observation: string } | null> {
  const { host, action, target, tool, meta, ownerGeneration, confirmedShellMutation, obsParts } = input
  const lastResult = input.result
  const isOwnerCurrent = () => host.isSubmissionCurrent(ownerGeneration) && (input.isOwnerCurrent?.() ?? true)
  // B1/B2: only authoritative verifier commands update the completion receipt.
  if (isFatalWindowsProcessExit(lastResult.exit_code) && target) {
    host.platformUnusableVerifiers.add(target);
  }
  let receipt: Awaited<
    ReturnType<typeof captureAndRecordVerifierReceipt>
  > = null;
  try {
    receipt = await captureAndRecordVerifierReceipt({
      projectRoot: requireProjectRoot(host.options),
      canPublish: () => isOwnerCurrent() && (input.canPublish?.() ?? true),
      command: target,
      exitCode: lastResult.exit_code,
      simulated: lastResult.simulated === true,
      summary: formatVerifierReceiptSummary({
        verifierId: target,
        command: target,
        exitCode: lastResult.exit_code,
        stdout: lastResult.stdout,
        stderr: lastResult.stderr,
      }),
      ...(lastResult.stdout !== undefined ? { stdout: lastResult.stdout } : {}),
      ...(lastResult.stderr !== undefined ? { stderr: lastResult.stderr } : {}),
      mutationPaths: mutationPathsFromSessionEvents(
        host.parity.sessionEvents.events,
      ),
      allowRepositoryScopeForRedRecovery: lastResult.exit_code !== 0,
      allowRepositoryScopeForGreenNoChange:
        lastResult.exit_code === 0 && host.writeCount === 0,
      sessionEvents: host.parity.sessionEvents,
      turnId: String(host.parity.turnId ?? host._turnIndex),
      ledger: host.executedVerifierLedger,
      cache: host.verifierReceiptCache,
      writeCount: host.writeCount,
      cacheIdentity: input.cacheIdentity ?? resolveVerifierCacheIdentity({
        projectRoot: requireProjectRoot(host.options),
        command: target,
        ...((action.type === "run_command" || action.type === "test_run") &&
          action.cwd !== undefined
          ? { cwd: action.cwd }
          : {}),
      }),
      toolCallId:
        meta.idempotencyKey ??
        host._streamNativeToolCallIds[meta.index] ??
        `tool_call_${host._turnIndex}_${meta.index}`,
    });
  } catch (verifierErr) {
    // R0-7/R0-8: a superseded submission must not invalidate the live
    // task's verifier ledger from a stale capture failure.
    if (!isOwnerCurrent()) {
      return host.settleStaleActionResult(
        tool,
        target,
        meta.index,
        "parent submission superseded before the verifier settled",
      );
    }
    // A verifier-receipt capture failure must degrade to "no receipt",
    // never fall through to the generic catch: that path records a
    // second terminal for an already-settled tool call and corrupts the
    // outbound tool protocol on the next provider request.
    invalidateVerifierLedger(
      host as never,
      "verifier receipt capture failed",
    );
    obsParts.push(
      `### verifier_receipt_unavailable\n${
        verifierErr instanceof Error
          ? verifierErr.message
          : String(verifierErr)
      }`,
    );
  }
  // R0-7/R0-8: verifier capture is a suspension point. A superseded
  // submission must not install its receipt, working state or ledger
  // invalidation on the task that now owns the engine.
  if (!isOwnerCurrent()) {
    return host.settleStaleActionResult(
      tool,
      target,
      meta.index,
      "parent submission superseded before the verifier settled",
    );
  }
  if (receipt) {
    host.lastVerifierReceipt = receipt;
    const previousFailureSignature =
      host.workingState.failureSurface?.errorSignature;
    const recoveryBinding =
      lastResult.exit_code !== 0
        ? host.currentRecoveryBinding()
        : null;
    const ingested = ingestVerifierResult({
      state: host.workingState,
      tool: action.type,
      target,
      exitCode: lastResult.exit_code,
      stdout: lastResult.stdout,
      stderr: lastResult.stderr,
      summary: receipt.summary ?? String(lastResult.exit_code),
      verifierId: target,
      recoveryProjectRoot: requireProjectRoot(host.options),
      ...(recoveryBinding ? { recoveryBinding } : {}),
      ...(receipt.boundRevision?.compositeTreeHash
        ? {
            workspaceRevision: String(
              receipt.boundRevision.compositeTreeHash,
            ),
          }
        : {}),
    });
    host.workingState = ingested.state;
    host.persistRecoveryWorkingState();
    host.lastVerifierFailed = ingested.lastVerifierFailed;
    const surfaceKind = host.workingState.failureSurface?.kind;
    // Only a *classified* implementation failure spends implementation
    // repair budget. An unclassified/unknown failure may be a transport
    // or environment error after a mutation; charging it would blame the
    // repair strategy for something it did not cause.
    const implementationRepairSurface =
      surfaceKind === "TEST_FAILURE" ||
      surfaceKind === "TYPECHECK_FAILURE" ||
      surfaceKind === "BUILD_FAILURE" ||
      surfaceKind === "LINT_FAILURE" ||
      surfaceKind === "RUNTIME_FAILURE";
    if (
      implementationRepairSurface &&
      host.workingState.failureSurface &&
      host.workingState.failureSurface.causality !==
        "pre_existing" &&
      host.workingState.failureSurface.errorSignature !==
        previousFailureSignature
    ) {
      host.consumeFailureBudget(
        makeFailureCapsule(
          "implementation",
          host.workingState.failureSurface.kind,
          host.workingState.failureSurface.errorSignature,
          {
            evidence_refs:
              host.workingState.failureSurface.evidenceRefs,
          },
        ),
      );
    }
  } else if (
    lastResult.exit_code !== 0 &&
    host.workingState.lastMutation
  ) {
    // A red command without a durable verifier receipt cannot grant
    // recovery authority. Keep the failed candidate closed until an
    // authoritative verifier can bind a fresh failure and revision.
    host.workingState = applyWorkingStateEvent(
      host.workingState,
      {
        type: "recovery_gate",
        failureSignature: "unbound-red-verifier",
        requiredEvidence:
          "Rerun an authoritative verifier to bind this failure to the current candidate.",
      },
    );
    host.persistRecoveryWorkingState();
    host.lastVerifierFailed = true;
  } else if (
    lastResult.exit_code === 0 &&
    !confirmedShellMutation &&
    lastResult.simulated !== true
  ) {
    invalidateVerifierLedger(
      host as never,
      "non-verifier shell command executed",
    );
  }

  return null
}

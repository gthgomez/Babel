/**
 * read_range executor path — extracted from chatEngineActionExecutor.ts to
 * stay under the repo's 2,000-line file-size ratchet (same pattern as the
 * background-shell handlers in chatBackgroundShell.ts).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveChatRangePath } from "../chatReadOnly.js";
import {
  evaluateReadRequest,
  formatReadObservation,
} from "./readWindow.js";
import {
  applyWorkingStateEvent,
  recordControllerRecoveryStrategy,
} from "./workingState.js";
import { isDiscriminatingInspectionEvidence } from "../chatEngineHelpers.js";
import { recoveryTargetIdentity } from "./recoveryIdentity.js";
import type { ChatEngineActionExecutorHost } from "../chatEngineContracts.js";
import type { ChatToolAction } from "../chatToolDefinitions.js";
import type { ChatCallbacks } from "../chatEngineContracts.js";

export interface ReadRangeActionContext {
  host: ChatEngineActionExecutorHost;
  action: Extract<ChatToolAction, { type: "read_range" }>;
  tool: string;
  target: string;
  toolId: number;
  meta: { index: number };
  ownerGeneration: number;
  callbacks: ChatCallbacks;
}

/** Execute a read_range action: windowed read with cache + recovery evidence. */
export async function executeReadRangeAction(
  ctx: ReadRangeActionContext,
): Promise<{ index: number; observation: string }> {
  const { host, action, tool, target, toolId, meta } = ctx;
  const rPath = resolveChatRangePath(host.options.projectRoot, action.file_path);
  const rContent = await readFile(rPath, "utf-8");
  // R0-8: the read is a suspension point; a superseded submission must not
  // append its result for the new task.
  if (!host.isSubmissionCurrent(ctx.ownerGeneration)) {
    return host.settleStaleActionResult(
      tool,
      target,
      meta.index,
      "parent submission superseded before the action settled",
    );
  }
  const rHash = host.hashContent(rContent);
  const rKey = host.readCacheKey(rPath);
  // read_range does not bump fullReadCounts (line windows allowed)
  host.noteToolForReadThrash(tool);
  const evaluated = evaluateReadRequest({
    pathKey: rKey,
    fileHash: rHash,
    content: rContent,
    request: {
      kind: "range",
      startLine: action.start_line,
      endLine: action.end_line,
    },
    cache: host.readCache,
    contextEpoch: host.readContextEpoch,
  });
  if (
    evaluated.window.lines.length === 0 &&
    action.start_line > evaluated.window.totalLines
  ) {
    host.toolCallLog.push({
      tool,
      target,
      detail: "error",
      error: "start_line out of range",
      index: meta.index,
      exit_code: 1,
    });
    ctx.callbacks?.onToolComplete?.(toolId, "error", "start_line out of range", 1);
    return {
      index: meta.index,
      observation: `### read_range ${target}\nError: start_line (${action.start_line}) exceeds file length (${evaluated.window.totalLines})`,
    };
  }
  host.toolCallLog.push({
    tool,
    target,
    detail: `${evaluated.window.lines.length} lines`,
    index: meta.index,
    exit_code: 0,
  });
  ctx.callbacks?.onToolComplete?.(
    toolId,
    `${evaluated.window.lines.length} lines`,
    undefined,
    0,
  );
  if (host.isSubmissionCurrent(ctx.ownerGeneration)) {
    const evidence = `${action.type}:${target}`;
    const discrimination = isDiscriminatingInspectionEvidence(
      host.workingState,
      action,
      recoveryTargetIdentity(host.options.projectRoot, action.file_path),
      host.workingState.recoveryGate ? host.currentRecoveryBinding() : null,
      evaluated.window.lines.join("\n").trim()
        ? createHash("sha256").update(evaluated.window.lines.join("\n")).digest("hex")
        : "",
    );
    host.workingState = applyWorkingStateEvent(host.workingState, {
      type: "add_evidence",
      evidence,
      file: action.file_path,
      discriminating: discrimination.discriminating,
      ...(discrimination.provenance ? { provenance: discrimination.provenance } : {}),
    });
    if (discrimination.discriminating) {
      host.workingState = recordControllerRecoveryStrategy(host.workingState, {
        target,
        evidence,
      });
      host.persistRecoveryWorkingState();
    }
    host.finishRecoveryLocalizationInspection({
      tool: "read_range",
      rawTarget: action.file_path,
      content: evaluated.window.lines.join("\n"),
      succeeded: true,
      startLine: evaluated.window.startLine,
    });
  }
  return {
    index: meta.index,
    observation: formatReadObservation("read_range", target, evaluated.window),
  };
}

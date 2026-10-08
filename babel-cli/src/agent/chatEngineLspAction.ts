import type { TaskOperation } from '../config/chatTaskClass.js';
import { executeTool, type ToolContext } from '../localTools.js';
import type { ChatCallbacks, ChatEngineActionExecutorHost } from './chatEngineContracts.js';
import { executeLspChatToolAction } from './chatEngineSupport.js';
import { canUseChatLsp } from './chatLspPolicy.js';
import type { ChatToolAction } from './chatToolDefinitions.js';

/** Preserve LSP admission and submission ownership through action settlement. */
export async function executeChatLspAction(args: {
  host: ChatEngineActionExecutorHost;
  action: Extract<ChatToolAction, { type: 'lsp' }>;
  toolContext: ToolContext;
  callbacks: ChatCallbacks;
  meta: { index: number; idempotencyKey?: string; ownerGeneration?: number };
  ownerGeneration: number;
  acceptedOperation?: TaskOperation;
  tool: string;
  target: string;
  toolId: number;
}): Promise<{ index: number; observation: string; stop?: boolean }> {
  const { host, action, toolContext, callbacks, meta, ownerGeneration,
    acceptedOperation, tool, target, toolId } = args;
  if (!canUseChatLsp({
    hostFallbackAllowed: host.isolationBrokerFlags().hostFallbackAllowed,
    ...(acceptedOperation !== undefined ? { operation: acceptedOperation } : {}),
  })) {
    const detail = "LSP denied: Chat has no lease-governed language-server process adapter.";
    host.toolCallLog.push({
      tool,
      target,
      detail,
      error: "blocked",
      index: meta.index,
      exit_code: 1,
    });
    callbacks?.onToolComplete?.(toolId, detail, detail, 1);
    return { index: meta.index, observation: detail };
  }
  const lsp = await executeLspChatToolAction({
    action,
    toolContext: {
      ...toolContext,
      onBeforeDispatch: () =>
        host.persistToolStartedAtExecutorDispatch(action, meta),
    },
    executeTool,
  });
  // R0-8: an LSP call is a suspension point; a superseded submission must
  // not append its result to the current task's tool log.
  if (!host.isSubmissionCurrent(ownerGeneration)) {
    return host.settleStaleActionResult(
      tool,
      target,
      meta.index,
      "parent submission superseded before the action settled",
    );
  }
  host.toolCallLog.push({
    tool,
    target,
    detail: lsp.detail,
    index: meta.index,
    ...(lsp.exit_code !== undefined ? { exit_code: lsp.exit_code } : {}),
    ...(lsp.stdout !== undefined ? { stdout: lsp.stdout } : {}),
    ...(lsp.stderr !== undefined ? { stderr: lsp.stderr } : {}),
    ...(lsp.failed ? { error: "failed" as const } : {}),
  });
  callbacks?.onToolComplete?.(
    toolId,
    lsp.detail,
    lsp.failed ? lsp.stderr || "failed" : undefined,
    lsp.exit_code ?? (lsp.failed ? 1 : 0),
  );
  return { index: meta.index, observation: lsp.observation };
}

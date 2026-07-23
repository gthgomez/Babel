// ─── /fork and /rewind — thread-store branching (D4) ────────────────────────

import type { ReplContext } from '../context.js';
import { accentBright, error, muted, primary } from '../../ui/theme.js';
import {
  createEngineFromThreadCells,
  resyncEngineToThreadCells,
} from '../../services/threadStore/conversationSync.js';
import {
  forkThread,
  listThreadCheckpoints,
  rewindThread,
} from '../../services/threadStore/branching.js';
import {
  allocateThreadId,
  hydrateResumedThreadToScreen,
  loadThreadCells,
  threadStoreExists,
} from '../../services/threadStore/index.js';
import type { HistoryCellRecord } from '../../ui/historyCells/types.js';
import { hydrateReplTurnsFromCells } from '../chatTranscriptHydration.js';

function resolveActiveThreadId(ctx: ReplContext): string | null {
  return ctx.chatEngine?.getEngineRunId() ?? null;
}

function printCheckpoints(threadId: string): void {
  const checkpoints = listThreadCheckpoints(threadId);
  if (checkpoints.length === 0) {
    console.log(muted(`\n  No checkpoints in thread ${threadId}.\n`));
    return;
  }
  console.log(primary(`\n  Checkpoints for ${threadId}:\n`));
  for (const cp of checkpoints) {
    console.log(
      `    ${accentBright(cp.cell_id)}  ${muted(`turn ${cp.turn_id ?? '?'}`)}  ${muted(cp.kind)}  ${cp.preview}`,
    );
  }
  console.log(muted('\n  Use /fork <cell_id> or /rewind <cell_id>\n'));
}

async function rebindActiveThread(
  ctx: ReplContext,
  threadId: string,
  cells: HistoryCellRecord[],
  options: {
    task: string;
    targetRoot: string;
    workspaceRoot: string | null;
    resyncExisting?: boolean;
  },
): Promise<void> {
  if (options.resyncExisting && ctx.chatEngine) {
    resyncEngineToThreadCells(ctx.chatEngine, cells);
  } else {
    ctx.chatEngine = createEngineFromThreadCells(
      threadId,
      {
        task: options.task,
        projectRoot: options.targetRoot,
        ...(ctx.state.model !== undefined ? { model: ctx.state.model } : {}),
        workspaceRoot: options.workspaceRoot,
      },
      cells,
    );
  }

  hydrateResumedThreadToScreen(ctx, threadId);
  hydrateReplTurnsFromCells(ctx, cells, {
    targetRoot: options.targetRoot,
    workspaceRoot: options.workspaceRoot,
  });
  ctx.saveSessionState();
}

export async function handleFork(ctx: ReplContext, args: string[]): Promise<void> {
  const threadId = resolveActiveThreadId(ctx);
  if (!threadId) {
    console.log(error('\n  No active chat session. Start a chat turn first.\n'));
    return;
  }
  if (!threadStoreExists(threadId)) {
    console.log(error(`\n  Thread store not found for session ${threadId}.\n`));
    return;
  }

  const cellId = args[0];
  if (!cellId) {
    printCheckpoints(threadId);
    return;
  }

  try {
    const target = ctx.resolveCurrentTarget();
    const result = await forkThread(threadId, { upToCellId: cellId });
    const cells = loadThreadCells(result.new_thread_id);

    await rebindActiveThread(ctx, result.new_thread_id, cells, {
      task: `Forked from ${threadId}`,
      targetRoot: target.targetRoot,
      workspaceRoot: target.workspaceRoot ?? null,
    });

    console.log(
      `\n  ${accentBright('Forked session')} ${primary(result.new_thread_id)}` +
        `\n  ${muted(`from ${result.source_thread_id} at ${result.fork_point_cell_id}`)}` +
        `\n  ${muted(`${result.copied_cell_count} cells copied`)}` +
        `\n  ${muted('Continue chatting on the new branch.')}\n`,
    );
  } catch (err) {
    console.log(
      error(`\n  Fork failed: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  }
}

export async function handleRewind(ctx: ReplContext, args: string[]): Promise<void> {
  const threadId = resolveActiveThreadId(ctx);
  if (!threadId) {
    console.log(error('\n  No active chat session. Start a chat turn first.\n'));
    return;
  }
  if (!threadStoreExists(threadId)) {
    console.log(error(`\n  Thread store not found for session ${threadId}.\n`));
    return;
  }

  const cellId = args[0];
  if (!cellId) {
    printCheckpoints(threadId);
    return;
  }

  try {
    const result = await rewindThread(threadId, cellId);
    const cells = loadThreadCells(threadId);
    const targetRoot = ctx.lastTargetRoot ?? ctx.resolveCurrentTarget().targetRoot;
    const workspaceRoot = ctx.lastWorkspaceRoot ?? ctx.resolveCurrentTarget().workspaceRoot ?? null;

    await rebindActiveThread(ctx, threadId, cells, {
      task: `Rewound session ${threadId}`,
      targetRoot,
      workspaceRoot,
      resyncExisting: Boolean(ctx.chatEngine),
    });

    console.log(
      `\n  ${accentBright('Rewound session')} ${primary(result.thread_id)}` +
        `\n  ${muted(`kept ${result.kept_cell_count} cells (truncated ${result.truncated_cell_count})`)}` +
        `\n  ${muted(`checkpoint: ${result.rewind_point_cell_id}`)}\n`,
    );
  } catch (err) {
    console.log(
      error(`\n  Rewind failed: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  }
}

/** Generate a fresh thread id for tests and fork fallbacks. */
export function generateThreadId(): string {
  return allocateThreadId();
}
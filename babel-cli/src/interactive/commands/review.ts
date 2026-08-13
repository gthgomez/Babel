import type { ReplContext } from '../context.js';
import { muted, warning } from '../../ui/theme.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';
import { withPausedStdin } from '../../ui/inputCoordinator.js';
import { openLastReviewDiff } from '../../ui/diffReview.js';

function getDraft(ctx: ReplContext): string {
  const adapter = ctx.rl as unknown as { getInputText?: () => string };
  return adapter.getInputText?.() ?? '';
}

function setDraft(ctx: ReplContext, text: string): void {
  const adapter = ctx.rl as unknown as { setInputText?: (text: string) => void };
  adapter.setInputText?.(text);
}

export async function handleDiffReview(ctx: ReplContext): Promise<void> {
  const draft = getDraft(ctx);
  const target = ctx.resolveCurrentTarget();
  const result = await withPausedStdin(
    () =>
      openLastReviewDiff({
        getComposerDraft: () => draft,
        setComposerDraft: (text) => setDraft(ctx, text),
        cwd: target.targetRoot,
      }),
    ctx.rl,
  );
  setDraft(ctx, result.restoredDraft);
}

export function handleCancelTurn(ctx: ReplContext): void {
  if (!ctx.isRunning || !ctx.chatEngine) {
    OutputBuffer.getInstance().write(muted('\n  Nothing to cancel.\n'));
    return;
  }
  ctx.chatEngine.abortTurn();
  OutputBuffer.getInstance().write(warning('\n  Cancel requested.\n'));
}

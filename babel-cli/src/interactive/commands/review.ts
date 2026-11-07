import type { ReplContext } from '../context.js';
import { muted, warning } from '../../ui/theme.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';
import { withExclusiveStdin } from '../../ui/inputCoordinator.js';
import { openLastReviewDiff } from '../../ui/diffReview.js';

function getDraft(ctx: ReplContext): string {
  const adapter = ctx.rl as unknown as {
    getInputText?: () => string;
    line?: string;
  };
  return adapter.getInputText?.() ?? adapter.line ?? '';
}

function setDraft(ctx: ReplContext, text: string): void {
  const adapter = ctx.rl as unknown as {
    setInputText?: (value: string) => void;
    line?: string;
    cursor?: number;
    write?: (data: string | null, key?: { ctrl?: boolean; name?: string }) => void;
  };
  if (adapter.setInputText) {
    adapter.setInputText(text);
    return;
  }
  if (typeof adapter.line === 'string') {
    adapter.line = text;
    (adapter as { cursor?: number }).cursor = text.length;
    return;
  }
  if (adapter.write) {
    if (typeof adapter.line === 'string') {
      adapter.line = '';
      if (typeof adapter.cursor === 'number') adapter.cursor = 0;
    } else {
      adapter.write(null, { ctrl: true, name: 'u' });
    }
    adapter.write(text);
  } else {
    adapter.line = text;
  }
}

export async function handleDiffReview(ctx: ReplContext): Promise<void> {
  const draft = getDraft(ctx);
  const target = ctx.resolveCurrentTarget();
  const runReview = () =>
    openLastReviewDiff({
      getComposerDraft: () => draft,
      // Restore only after the exclusive terminal lease reattaches input.
      setComposerDraft: () => undefined,
      cwd: target.targetRoot,
    });
  const result = ctx.withExclusiveTerminal
    ? await ctx.withExclusiveTerminal('diff-review', runReview)
    : await withExclusiveStdin(runReview, ctx.rl);
  setDraft(ctx, result.restoredDraft);
}

export function handleCancelTurn(ctx: ReplContext): void {
  if (ctx.preparingRun && !ctx.isRunning && !ctx.cancelActiveRun) {
    OutputBuffer.getInstance().write(warning('\n  This preparation cannot be cancelled; wait for it to finish.\n'));
    return;
  }
  if ((!ctx.isRunning && !ctx.preparingRun) || (!ctx.cancelActiveRun && !ctx.chatEngine)) {
    OutputBuffer.getInstance().write(muted('\n  Nothing to cancel.\n'));
    return;
  }
  if (ctx.cancelActiveRun) ctx.cancelActiveRun();
  else ctx.chatEngine!.abortTurn();
  OutputBuffer.getInstance().write(warning('\n  Cancel requested.\n'));
}

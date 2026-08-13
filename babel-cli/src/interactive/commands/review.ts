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
    write?: (data: string | null, key?: { ctrl?: boolean; name?: string }) => void;
  };
  if (adapter.setInputText) {
    adapter.setInputText(text);
    return;
  }
  if (adapter.write) {
    adapter.write(null, { ctrl: true, name: 'u' });
    adapter.write(text);
  } else {
    adapter.line = text;
  }
}

export async function handleDiffReview(ctx: ReplContext): Promise<void> {
  const draft = getDraft(ctx);
  const target = ctx.resolveCurrentTarget();
  const result = await withExclusiveStdin(
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

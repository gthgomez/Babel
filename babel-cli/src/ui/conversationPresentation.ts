import { isRendererPresentationSuspended, onRendererPresentationResume } from './rendererFence.js';

/** Ordered, immutable conversation paints; ephemeral HUD ticks never enter this queue. */
export class ConversationPresentation {
  private pending: Array<{ action: () => void; preview: boolean }> = [];
  private unregister: (() => void) | null = null;

  run(action: () => void): void {
    this.enqueue(action, false);
  }

  /** Keep only the latest mutable paint between immutable output boundaries. */
  preview(action: () => void): void {
    this.enqueue(action, true);
  }

  private enqueue(action: () => void, preview: boolean): void {
    if (!isRendererPresentationSuspended()) {
      this.flush();
      action();
      return;
    }
    if (preview && this.pending.at(-1)?.preview) this.pending[this.pending.length - 1] = { action, preview };
    else this.pending.push({ action, preview });
    if (!this.unregister) {
      this.unregister = onRendererPresentationResume(() => {
        this.unregister = null;
        this.flush();
      });
    }
  }

  flush(): void {
    if (isRendererPresentationSuspended()) return;
    this.unregister?.();
    this.unregister = null;
    // Retain ownership even if the renderer stopped while the surface was open.
    const actions = this.pending.splice(0);
    for (const { action } of actions) action();
  }
}

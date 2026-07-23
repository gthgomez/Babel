/**
 * TuiStateInjector — Bridges voice pipeline text output into Babel's PromptInput.
 *
 * This is the ONLY module that touches PromptInput state. All voice text
 * insertion flows through two methods:
 *   - injectRaw() for Phase 1 streaming STT output
 *   - replaceWithRefined() for Phase 2 LLM-refined replacement
 *
 * The injector tracks the injected text range and monitors for user activity
 * (manual typing) to safely abort Phase 2 replacement when collisions occur.
 *
 * Design principle: "Keep raw text on any ambiguity."
 * The raw STT output is always valid text. LLM refinement is an optimization.
 * If there's any doubt about safety, keep the raw text. Never delete user-typed content.
 *
 * @module voice/tui-state-injector
 */

import type { PromptInput } from '../ui/promptInput.js';
import type { UserEditCollision } from './types.js';

// Re-export for convenience
export type { PromptInput };

// ── Types ───────────────────────────────────────────────────────────────────

interface InjectedRange {
  /** Character offset from start of buffer where raw text begins. */
  startOffset: number;
  /** Number of characters injected. */
  charCount: number;
  /** Full buffer text at time of injection (for integrity verification). */
  bufferSnapshot: string;
}

// ── TuiStateInjector ───────────────────────────────────────────────────────

export class TuiStateInjector {
  private promptInput: PromptInput | null = null;
  private injectedRange: InjectedRange | null = null;
  private userModifiedSinceInject = false;
  private active = false;
  private lastKnownText = '';
  private unregisterSubmit: (() => void) | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Bind to a PromptInput instance. Called when voice mode activates.
   */
  attach(promptInput: PromptInput): void {
    this.promptInput = promptInput;
    this.active = true;
    this.userModifiedSinceInject = false;
    this.injectedRange = null;
    this.lastKnownText = promptInput.getState().text;

    // Monitor submits for collision detection
    this.unregisterSubmit = promptInput.onSubmit(() => {
      this.userModifiedSinceInject = true;
    });
  }

  /**
   * Unbind. Called when voice mode deactivates.
   */
  detach(): void {
    this.active = false;
    this.promptInput = null;
    this.injectedRange = null;

    if (this.unregisterSubmit) {
      this.unregisterSubmit();
      this.unregisterSubmit = null;
    }
  }

  /** Whether the injector is currently tracking an active injection. */
  isActive(): boolean {
    return this.active;
  }

  // ── Phase 1: Raw injection ─────────────────────────────────────────────

  /**
   * Insert raw STT text into the PromptInput buffer.
   *
   * Strategy: Use PromptInput's public setText() + getState() to append
   * text at the end of the current buffer. Records the injected range for
   * potential Phase 2 replacement.
   *
   * Collision guard: Arms the userModifiedSinceInject flag BEFORE calling
   * setText(). The order is:
   *   1. Read current state
   *   2. Compute new text
   *   3. Arm collision detection
   *   4. Call setText()
   *   5. Record injected range
   */
  injectRaw(text: string): void {
    if (!this.promptInput || !this.active) return;

    const state = this.promptInput.getState();
    const currentText = state.text;

    // Arm collision detection BEFORE mutation
    this.userModifiedSinceInject = false;
    this.lastKnownText = currentText;

    // Append text at end of buffer
    const newText = currentText + text;
    const startOffset = currentText.length;

    // Perform the injection
    this.promptInput.setText(newText);

    // Record for potential Phase 2 replacement
    this.injectedRange = {
      startOffset,
      charCount: text.length,
      bufferSnapshot: newText,
    };
  }

  // ── Phase 2: Refined replacement ───────────────────────────────────────

  /**
   * Replace the raw text block with LLM-refined text.
   *
   * Guards (any failure → abort, keep raw text):
   *   1. userModifiedSinceInject → user typed during refinement
   *   2. Injected range no longer valid → buffer changed
   *   3. promptInput not available → detached
   *
   * @param refinedText  The LLM-polished text to swap in.
   * @returns true if the replacement succeeded, false if aborted.
   */
  replaceWithRefined(refinedText: string): boolean {
    if (!this.promptInput || !this.active) return false;
    if (!this.injectedRange) return false;
    if (this.userModifiedSinceInject) return false;

    // Verify buffer integrity — has it changed since injection?
    const currentText = this.promptInput.getState().text;
    if (currentText !== this.injectedRange.bufferSnapshot) {
      // Buffer was modified — abort
      return false;
    }

    const { startOffset, charCount } = this.injectedRange;

    // Reconstruct: text before + refined + text after
    const before = currentText.slice(0, startOffset);
    const after = currentText.slice(startOffset + charCount);
    const newFullText = before + refinedText + after;

    // Perform the replacement
    this.promptInput.setText(newFullText);

    // Clear tracking
    this.injectedRange = null;
    this.userModifiedSinceInject = false;

    return true;
  }

  // ── Collision detection ────────────────────────────────────────────────

  /**
   * Called by PromptInput's key handler when the user types during voice session.
   * The caller (VoiceStreamManager) polls this to detect user activity.
   */
  notifyUserKeypress(): void {
    if (!this.active) return;

    const currentText = this.promptInput?.getState().text ?? '';
    if (currentText !== this.lastKnownText) {
      this.userModifiedSinceInject = true;
      this.lastKnownText = currentText;
    }
  }

  /**
   * Check for user edit collisions.
   * Called by VoiceStreamManager to decide whether to abort refinement.
   */
  detectCollision(): UserEditCollision {
    if (!this.active || !this.promptInput) {
      return { type: 'none' };
    }

    if (this.userModifiedSinceInject) {
      const currentText = this.promptInput.getState().text;
      if (currentText.trim() === '') {
        return { type: 'user_cleared_buffer' };
      }
      return { type: 'user_typed_during_refinement', affectedText: currentText };
    }

    return { type: 'none' };
  }
}

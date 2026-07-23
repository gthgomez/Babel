/**
 * DualPhaseStateMachine — Formal state engine for the voice dictation pipeline.
 *
 * A pure functional state machine. No side effects — it returns new state +
 * commands for the caller (VoiceStreamManager) to execute. This separation
 * makes the state machine fully testable without mocking any I/O.
 *
 * States: IDLE → CAPTURING → RAW_STREAMING → REFINING → COMPLETED / ABORTED
 *
 * @module voice/dual-phase-state-machine
 */

import {
  VoicePhase,
  type VoiceSession,
  type SttToken,
  type SttFinalResult,
  type LlmRefinementResult,
  type AudioChunk,
} from './types.js';

// ── VoiceCommand ────────────────────────────────────────────────────────────

/** Side-effect commands returned by the state machine for the caller to execute. */
export type VoiceCommand =
  | { type: 'start_audio_capture' }
  | { type: 'stop_audio_capture' }
  | { type: 'send_audio_to_stt'; chunk: AudioChunk }
  | { type: 'inject_raw_text'; text: string }
  | { type: 'replace_with_refined'; oldText: string; newText: string }
  | { type: 'request_llm_refinement'; rawText: string; context: string }
  | { type: 'notify_phase_change'; phase: VoicePhase }
  | { type: 'notify_error'; message: string };

// ── Transition result ───────────────────────────────────────────────────────

export interface TransitionResult {
  commands: VoiceCommand[];
  session: VoiceSession;
}

// ── DualPhaseStateMachine ───────────────────────────────────────────────────

export class DualPhaseStateMachine {
  private session: VoiceSession | null = null;
  private accumulatedRawText = '';
  private rawCharCount = 0;
  /** Whether the user typed manually during the current session. */
  private userWasActive = false;
  /** Reset timer handle for auto-return to IDLE. */
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Callback invoked when the auto-reset timer fires. */
  onAutoReset: ((result: TransitionResult) => void) | null = null;

  // ── Factory ────────────────────────────────────────────────────────────

  /** Create a new idle session object (does not start the machine). */
  private createSession(): VoiceSession {
    return {
      id: crypto.randomUUID(),
      phase: VoicePhase.Idle,
      startedAt: 0,
      rawText: '',
      refinedText: null,
      rawCharCount: 0,
      chunksProcessed: 0,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Get the current session, or null if IDLE with no prior session. */
  getSession(): VoiceSession | null {
    return this.session;
  }

  /** Whether the machine is in an active (non-idle) state. */
  isActive(): boolean {
    return (
      this.session !== null &&
      this.session.phase !== VoicePhase.Idle &&
      this.session.phase !== VoicePhase.Completed &&
      this.session.phase !== VoicePhase.Aborted
    );
  }

  /**
   * Start a new voice capture session.
   * Transitions IDLE → CAPTURING.
   *
   * @returns Commands: start_audio_capture, notify_phase_change.
   */
  start(): TransitionResult {
    this.clearResetTimer();
    this.session = this.createSession();
    this.session.phase = VoicePhase.Capturing;
    this.session.startedAt = performance.now();
    this.accumulatedRawText = '';
    this.rawCharCount = 0;
    this.userWasActive = false;

    return {
      commands: [
        { type: 'start_audio_capture' },
        { type: 'notify_phase_change', phase: VoicePhase.Capturing },
      ],
      session: this.session,
    };
  }

  /**
   * Handle an incoming STT streaming token.
   * If first token: transitions CAPTURING → RAW_STREAMING.
   * Otherwise: stays in RAW_STREAMING.
   *
   * @returns Commands: inject_raw_text (always), notify_phase_change (on first token).
   */
  onSttToken(token: SttToken): TransitionResult {
    if (!this.session) return this.noop();

    // First token triggers phase transition
    if (this.session.phase === VoicePhase.Capturing) {
      this.session.phase = VoicePhase.RawStreaming;
      this.session.rawText = token.text;
      this.rawCharCount = token.text.length;
      this.accumulatedRawText = token.text;

      return {
        commands: [
          { type: 'inject_raw_text', text: token.text },
          { type: 'notify_phase_change', phase: VoicePhase.RawStreaming },
        ],
        session: this.session,
      };
    }

    // Subsequent tokens
    if (this.session.phase === VoicePhase.RawStreaming) {
      // For interim tokens, replace the previous partial with the new accumulated text.
      // For final tokens, append.
      if (token.isFinal) {
        // isFinal sends the COMPLETE transcript, not a delta — overwrite, don't append
        this.accumulatedRawText = token.text;
        this.session.rawText = token.text;
        this.rawCharCount = token.text.length;
        return { commands: [], session: this.session };  // deltas already injected
      } else {
        // Interim: update the accumulated text but don't double-count
        this.accumulatedRawText = token.text;
        this.session.rawText = token.text;
        return {
          commands: [{ type: 'inject_raw_text', text: token.text }],
          session: this.session,
        };
      }
    }

    return this.noop();
  }

  /**
   * Handle STT completion.
   * Transitions RAW_STREAMING → REFINING.
   *
   * @returns Commands: stop_audio_capture, request_llm_refinement, notify_phase_change.
   */
  onSttComplete(result: SttFinalResult): TransitionResult {
    if (!this.session) return this.noop();

    if (this.session.phase !== VoicePhase.RawStreaming) {
      return this.abort('STT completed without streaming tokens — empty utterance');
    }

    // Update raw text with the final complete transcript
    this.accumulatedRawText = result.text;
    this.session.rawText = result.text;
    this.rawCharCount = result.text.length;
    this.session.phase = VoicePhase.Refining;

    return {
      commands: [
        { type: 'stop_audio_capture' },
        {
          type: 'request_llm_refinement',
          rawText: result.text,
          context: 'Babel TUI — TypeScript/Node.js',
        },
        { type: 'notify_phase_change', phase: VoicePhase.Refining },
      ],
      session: this.session,
    };
  }

  /**
   * Handle LLM refinement result.
   * Transitions REFINING → COMPLETED (or keeps raw if user was active).
   *
   * @returns Commands: replace_with_refined (if safe) or notify_phase_change (keep raw).
   */
  onLlmResult(result: LlmRefinementResult): TransitionResult {
    if (!this.session) return this.noop();

    if (this.session.phase !== VoicePhase.Refining) {
      return this.noop();
    }

    this.session.refinedText = result.refinedText;
    this.session.phase = VoicePhase.Completed;

    const commands: VoiceCommand[] = [];

    if (!this.userWasActive && result.changed) {
      commands.push({
        type: 'replace_with_refined',
        oldText: this.session.rawText,
        newText: result.refinedText,
      });
    }

    commands.push({ type: 'notify_phase_change', phase: VoicePhase.Completed });
    this.scheduleReset();

    return { commands, session: this.session };
  }

  /**
   * User typed manually during the pipeline — mark as active.
   * If in REFINING phase, aborts the refinement.
   *
   * @returns Commands: may include notify_phase_change (ABORTED).
   */
  onUserActivity(): TransitionResult {
    if (!this.session) return this.noop();

    this.userWasActive = true;

    if (this.session.phase === VoicePhase.RawStreaming) {
      this.session.phase = VoicePhase.Aborted;
      const commands: VoiceCommand[] = [
        { type: 'stop_audio_capture' },
        { type: 'notify_phase_change', phase: VoicePhase.Aborted },
      ];
      this.scheduleReset();
      return { commands, session: this.session };
    }

    // During REFINING: don't abort yet — let onLlmResult decide
    // based on the userWasActive flag
    return this.noop();
  }

  /**
   * Abort the current session.
   * Transitions any active phase → ABORTED.
   *
   * @returns Commands: stop_audio_capture, notify_phase_change.
   */
  abort(reason: string): TransitionResult {
    if (!this.session) return this.noop();

    this.session.phase = VoicePhase.Aborted;
    const commands: VoiceCommand[] = [
      { type: 'stop_audio_capture' },
      { type: 'notify_phase_change', phase: VoicePhase.Aborted },
    ];

    if (reason) {
      commands.push({ type: 'notify_error', message: reason });
    }

    this.scheduleReset();
    return { commands, session: this.session };
  }

  /**
   * Timeout during CAPTURING or RAW_STREAMING.
   * Transitions → ABORTED with timeout reason.
   */
  onTimeout(): TransitionResult {
    return this.abort('Capture timeout — no speech detected within limit');
  }

  /**
   * Reset to IDLE (called after COMPLETED/ABORTED display period).
   */
  reset(): TransitionResult {
    this.clearResetTimer();
    const prevSession = this.session;
    this.session = null;
    this.accumulatedRawText = '';
    this.rawCharCount = 0;
    this.userWasActive = false;

    return {
      commands: [{ type: 'notify_phase_change', phase: VoicePhase.Idle }],
      session: prevSession ?? this.createSession(),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private noop(): TransitionResult {
    return {
      commands: [],
      session: this.session ?? this.createSession(),
    };
  }

  private scheduleReset(): void {
    this.clearResetTimer();
    this.resetTimer = setTimeout(() => {
      const result = this.reset();
      this.onAutoReset?.(result);
    }, 2000); // Hold COMPLETED/ABORTED state for 2s for UI indicator
  }

  private clearResetTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}

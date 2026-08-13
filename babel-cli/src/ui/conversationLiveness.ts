import type { ChatPhase } from "../agent/chatPhaseNudge.js";
import { getMotionMode, shimmerText } from "./motion.js";
import { dim, muted, warning } from "./theme.js";

const STALL_THRESHOLD_MS = 3_000;

export interface ConversationLivenessSnapshot {
  elapsedMs: number;
  phase: ChatPhase;
  modelIdleMs: number;
}

export class ConversationLivenessTracker {
  private phase: ChatPhase = "investigate";
  private lastModelActivityAt = Date.now();

  recordModelActivity(): void {
    this.lastModelActivityAt = Date.now();
  }

  setPhase(phase: ChatPhase): void {
    this.phase = phase;
    this.recordModelActivity();
  }

  reset(): void {
    this.phase = "investigate";
    this.recordModelActivity();
  }

  snapshot(startedAt: number, now = Date.now()): ConversationLivenessSnapshot {
    return {
      elapsedMs: Math.max(0, now - startedAt),
      phase: this.phase,
      modelIdleMs: Math.max(0, now - this.lastModelActivityAt),
    };
  }
}

export function formatConversationThinkingStatus(input: {
  spinner: string;
  stallMs: number;
  snapshot: ConversationLivenessSnapshot;
}): { indicator: string; timer: string } {
  const thinkingLabel = shimmerText("Thinking…", getMotionMode());
  let indicator = dim(
    `${input.spinner} ${thinkingLabel} [${input.snapshot.phase}]`,
  );
  if (input.stallMs > STALL_THRESHOLD_MS) {
    const intensity = Math.min((input.stallMs - STALL_THRESHOLD_MS) / 2_000, 1);
    if (intensity > 0.6) indicator = warning(indicator);
    else if (intensity > 0.3) {
      indicator = `${dim(input.spinner)} ${warning(thinkingLabel)}`;
    }
  }
  return {
    indicator,
    timer: muted(
      `(${Math.floor(input.snapshot.elapsedMs / 1_000)}s · model idle ${Math.floor(
        input.snapshot.modelIdleMs / 1_000,
      )}s)`,
    ),
  };
}

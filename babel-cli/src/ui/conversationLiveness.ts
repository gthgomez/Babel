import type { ChatPhase } from "../agent/chatPhaseNudge.js";
import { primary, muted } from "./theme.js";

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
  const totalSec = Math.floor(input.snapshot.elapsedMs / 1_000);
  const reqSec = Math.floor(input.snapshot.modelIdleMs / 1_000);
  const showReqTimer =
    input.snapshot.modelIdleMs >= 1_000 &&
    input.snapshot.elapsedMs - input.snapshot.modelIdleMs >= 5_000;
  return {
    indicator: primary(`${input.spinner} Thinking… [${input.snapshot.phase}]`),
    timer: muted(
      showReqTimer
        ? `(response ${totalSec}s · req ${reqSec}s · Ctrl+C cancel)`
        : `(response ${totalSec}s · Ctrl+C cancel)`,
    ),
  };
}

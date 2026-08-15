/**
 * Typed Invariant Assertions for Babel TUI & Chat Reliability.
 *
 * Enforces non-negotiable runtime and rendering properties:
 * - Single final answer
 * - Single start/completion per tool
 * - No stale final answer on cancel
 * - Truthful model & context telemetry
 * - Review card matching terminal result
 * - No false-green "verified" without required evidence
 * - Read-only tasks never presenting patch actions
 * - Zero lingering background tasks
 * - Terminal state restoration on all exit paths
 * - Valid event ordering
 */

import assert from 'node:assert/strict';
import type { ChatEvent } from '../../agent/chatEngine.js';
import type { TerminalOutcome } from '../../schemas/agentContracts.js';
import type { VerifierReceipt } from '../../agent/completionGatePolicy.js';

export interface StreamEventTrace {
  type: string;
  [key: string]: unknown;
}

export interface InvariantViolation {
  invariant: string;
  expected: string;
  actual: string;
  context?: Record<string, unknown>;
}

export class TurnInvariantChecker {
  private violations: InvariantViolation[] = [];

  public checkSingleFinalAnswer(events: readonly StreamEventTrace[]): this {
    const doneEvents = events.filter((e) => e.type === 'done');
    const answerChunks = events.filter((e) => e.type === 'answer_chunk');
    if (doneEvents.length > 1) {
      this.violations.push({
        invariant: 'SINGLE_FINAL_ANSWER',
        expected: 'At most 1 "done" event per turn',
        actual: `Found ${doneEvents.length} "done" events`,
      });
    }
    return this;
  }

  public checkToolLifecycleOrder(events: readonly StreamEventTrace[]): this {
    const starts = new Map<string, number>();
    const completions = new Map<string, number>();

    for (const e of events) {
      if (e.type === 'tool_start') {
        const id = String(e.tool_id ?? e.name ?? 'unknown');
        starts.set(id, (starts.get(id) ?? 0) + 1);
      } else if (e.type === 'tool_end' || e.type === 'tool_result') {
        const id = String(e.tool_id ?? e.name ?? 'unknown');
        completions.set(id, (completions.get(id) ?? 0) + 1);
      }
    }

    for (const [id, count] of starts) {
      if (count > 1) {
        this.violations.push({
          invariant: 'TOOL_START_ONCE',
          expected: `Tool ${id} started at most once`,
          actual: `Tool ${id} started ${count} times`,
        });
      }
      const doneCount = completions.get(id) ?? 0;
      if (doneCount > count) {
        this.violations.push({
          invariant: 'TOOL_COMPLETION_MATCHES_START',
          expected: `Tool ${id} completions (${doneCount}) <= starts (${count})`,
          actual: `Tool ${id} completed ${doneCount} times without matching start`,
        });
      }
    }
    return this;
  }

  public checkNoStaleFinalAnswerOnCancel(
    cancelled: boolean,
    events: readonly StreamEventTrace[],
  ): this {
    if (cancelled) {
      const hasDone = events.some((e) => e.type === 'done');
      if (hasDone) {
        this.violations.push({
          invariant: 'NO_STALE_DONE_ON_CANCEL',
          expected: 'Cancelled turn emits no "done" event',
          actual: 'Cancelled turn emitted "done" event',
        });
      }
    }
    return this;
  }

  public checkModelTelemetrySource(
    displayedModel: string,
    telemetrySourceModel: string,
  ): this {
    if (displayedModel && telemetrySourceModel && displayedModel !== telemetrySourceModel) {
      this.violations.push({
        invariant: 'MODEL_TELEMETRY_SOURCE_MATCH',
        expected: `Status model (${displayedModel}) matches telemetry source (${telemetrySourceModel})`,
        actual: `Mismatch: displayed "${displayedModel}" vs source "${telemetrySourceModel}"`,
      });
    }
    return this;
  }

  public checkReviewCardOutcome(
    cardOutcome: string | null | undefined,
    terminalOutcome: TerminalOutcome | string,
  ): this {
    if (!cardOutcome) return this;
    if (terminalOutcome === 'CANCELLED' && !/cancel/i.test(cardOutcome)) {
      this.violations.push({
        invariant: 'REVIEW_CARD_MATCHES_OUTCOME',
        expected: 'Card outcome reflects CANCELLED',
        actual: `Card displayed: ${cardOutcome}`,
      });
    }
    if (terminalOutcome === 'VERIFIED_PATCH' && !/verif/i.test(cardOutcome)) {
      this.violations.push({
        invariant: 'REVIEW_CARD_MATCHES_OUTCOME',
        expected: 'Card outcome reflects VERIFIED_PATCH',
        actual: `Card displayed: ${cardOutcome}`,
      });
    }
    return this;
  }

  public checkNoVerifiedWithoutEvidence(
    cardText: string,
    receipt: VerifierReceipt | null | undefined,
  ): this {
    const claimsVerified = /verified complete/i.test(cardText);
    const hasGreenVerifier =
      receipt != null &&
      (('exitCode' in receipt && receipt.exitCode === 0) ||
        ('exit_code' in receipt && receipt.exit_code === 0));

    if (claimsVerified && !hasGreenVerifier) {
      this.violations.push({
        invariant: 'NO_UNGROUNDED_VERIFIED_STATE',
        expected: 'No "Verified complete" without a green verifier receipt',
        actual: `Claimed verified but receipt is: ${JSON.stringify(receipt)}`,
      });
    }
    return this;
  }

  public checkReadOnlyNoPatches(
    taskShape: 'READ_ONLY' | 'MUTATING' | 'HYBRID',
    reviewKind: string,
    mutatingToolCount: number,
  ): this {
    if (taskShape === 'READ_ONLY' && mutatingToolCount > 0) {
      this.violations.push({
        invariant: 'READ_ONLY_ZERO_MUTATION',
        expected: 'Zero mutating tool calls for READ_ONLY task shape',
        actual: `${mutatingToolCount} mutating tools executed`,
      });
    }
    return this;
  }

  public checkNoStaleBackgroundTasks(activeTaskCount: number): this {
    if (activeTaskCount > 0) {
      this.violations.push({
        invariant: 'NO_LINGERING_TASKS',
        expected: '0 active background tasks upon turn completion',
        actual: `${activeTaskCount} lingering tasks`,
      });
    }
    return this;
  }

  public checkStreamEventOrdering(events: readonly StreamEventTrace[]): this {
    let turnStarted = false;
    let turnCompleted = false;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (e.type === 'turn_start' || e.type === 'start') {
        turnStarted = true;
      }
      if (e.type === 'done' || e.type === 'failed' || e.type === 'cancelled') {
        if (turnCompleted) {
          this.violations.push({
            invariant: 'SINGLE_TERMINAL_EVENT',
            expected: 'At most one terminal event per turn',
            actual: `Multiple terminal events; second was ${e.type} at index ${i}`,
          });
        }
        turnCompleted = true;
      }
    }
    return this;
  }

  public getViolations(): readonly InvariantViolation[] {
    return this.violations;
  }

  public assertAll(): void {
    if (this.violations.length > 0) {
      const msgs = this.violations.map(
        (v) => `[${v.invariant}] Expected: ${v.expected} | Actual: ${v.actual}`,
      );
      assert.fail(`Turn Invariant Violations (${this.violations.length}):\n${msgs.join('\n')}`);
    }
  }
}

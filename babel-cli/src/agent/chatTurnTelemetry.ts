/**
 * Structured Per-Turn Performance Telemetry for Chat & Interactive repl.
 *
 * Measures fine-grained timing breakdowns and transition latencies:
 * - Time to first token (TTFT)
 * - Provider invocation duration
 * - Tool execution duration
 * - Babel orchestration overhead
 * - Policy / verification overhead
 * - Compaction / critic / synthesis overhead
 * - Total turn wall time
 * - Token efficiency and intervention counts
 */

export interface TimeInterval {
  start: number;
  end: number;
}

/**
 * Computes total covered wall-clock duration of a set of intervals
 * by merging overlapping and contiguous ranges.
 */
export function computeIntervalUnionDuration(intervals: readonly TimeInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals]
    .filter((iv) => iv.end >= iv.start)
    .sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return 0;

  let total = 0;
  let currentStart = first.start;
  let currentEnd = first.end;

  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (!iv) continue;
    if (iv.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, iv.end);
    } else {
      total += Math.max(0, currentEnd - currentStart);
      currentStart = iv.start;
      currentEnd = iv.end;
    }
  }
  total += Math.max(0, currentEnd - currentStart);
  return total;
}

export interface ChatTurnTimingBreakdown {
  /** Timestamp when user submitted the turn (monotonic ms) */
  submittedAt: number;
  /** Timestamp when turn started processing (monotonic ms) */
  startedAt: number;
  /** Timestamp of first visible token / stream event (monotonic ms) */
  firstTokenAt: number | null;
  /** Time to first token in ms (firstTokenAt - submittedAt) */
  ttftMs: number | null;
  /** Aggregate duration of provider API requests in ms */
  providerDurationMs: number;
  /** Aggregate duration of tool executions in ms */
  toolDurationMs: number;
  /** Duration of verifier runs in ms */
  verificationDurationMs: number;
  /** Duration of critic / reviewer evaluations in ms */
  criticDurationMs: number;
  /** Duration of context compaction in ms */
  compactionDurationMs: number;
  /** Non-provider, non-tool Babel orchestration overhead in ms */
  orchestrationOverheadMs: number;
  /** Total turn wall-clock duration in ms */
  totalWallTimeMs: number;
}

export interface ChatTurnActivityCounts {
  /** Number of provider model invocations in this turn */
  modelInvocations: number;
  /** Total number of tool calls requested */
  toolCalls: number;
  /** Number of successful tool executions */
  successfulToolCalls: number;
  /** Number of failed tool executions */
  failedToolCalls: number;
  /** Number of duplicate / repeated tool calls */
  repeatedToolCalls: number;
  /** Number of policy interventions / nudges fired */
  policyInterventions: number;
}

export interface ChatTurnTelemetryRecord {
  turnId: string;
  taskClass: string;
  timing: ChatTurnTimingBreakdown;
  counts: ChatTurnActivityCounts;
  promptTokens: number | null;
  completionTokens: number | null;
  cumulativeSessionTokens: number;
}

export class ChatTurnTelemetryCollector {
  private nowFn: () => number;
  private submittedAt: number;
  private startedAt: number = 0;
  private firstTokenAt: number | null = null;
  private providerDurationMs: number = 0;
  private toolDurationMs: number = 0;
  private verificationDurationMs: number = 0;
  private criticDurationMs: number = 0;
  private compactionDurationMs: number = 0;
  private modelInvocations: number = 0;
  private toolCalls: number = 0;
  private successfulToolCalls: number = 0;
  private failedToolCalls: number = 0;
  private repeatedToolCalls: number = 0;
  private policyInterventions: number = 0;
  private pastTools: string[] = [];

  private providerIntervals: TimeInterval[] = [];
  private toolIntervals: TimeInterval[] = [];
  private verificationIntervals: TimeInterval[] = [];
  private criticIntervals: TimeInterval[] = [];
  private compactionIntervals: TimeInterval[] = [];

  constructor(submittedAt?: number, nowFn: () => number = () => performance.now()) {
    this.nowFn = nowFn;
    this.submittedAt = submittedAt ?? this.nowFn();
    this.startedAt = this.submittedAt;
  }

  public markStarted(): void {
    this.startedAt = this.nowFn();
  }

  public markFirstToken(): void {
    if (this.firstTokenAt === null) {
      this.firstTokenAt = this.nowFn();
    }
  }

  public startProviderSpan(): { end: () => void } {
    const start = this.nowFn();
    return {
      end: () => {
        const end = this.nowFn();
        this.recordProviderSpan(Math.max(0, end - start), start, end);
      },
    };
  }

  public startToolSpan(toolName: string, target: string): { end: (success: boolean) => void } {
    const start = this.nowFn();
    return {
      end: (success: boolean) => {
        const end = this.nowFn();
        this.recordToolSpan(toolName, target, Math.max(0, end - start), success, start, end);
      },
    };
  }

  public startVerificationSpan(): { end: () => void } {
    const start = this.nowFn();
    return {
      end: () => {
        const end = this.nowFn();
        this.recordVerificationSpan(Math.max(0, end - start), start, end);
      },
    };
  }

  public startCriticSpan(): { end: () => void } {
    const start = this.nowFn();
    return {
      end: () => {
        const end = this.nowFn();
        this.recordCriticSpan(Math.max(0, end - start), start, end);
      },
    };
  }

  public startCompactionSpan(): { end: () => void } {
    const start = this.nowFn();
    return {
      end: () => {
        const end = this.nowFn();
        this.recordCompactionSpan(Math.max(0, end - start), start, end);
      },
    };
  }

  public recordProviderSpan(durationMs: number, start?: number, end?: number): void {
    const d = Math.max(0, durationMs);
    this.providerDurationMs += d;
    this.modelInvocations += 1;
    const s = start ?? this.nowFn() - d;
    const e = end ?? s + d;
    this.providerIntervals.push({ start: s, end: e });
  }

  public recordToolSpan(
    toolName: string,
    target: string,
    durationMs: number,
    success: boolean,
    start?: number,
    end?: number,
  ): void {
    const d = Math.max(0, durationMs);
    this.toolDurationMs += d;
    this.toolCalls += 1;
    if (success) {
      this.successfulToolCalls += 1;
    } else {
      this.failedToolCalls += 1;
    }
    const signature = `${toolName}:${target}`;
    if (this.pastTools.includes(signature)) {
      this.repeatedToolCalls += 1;
    } else {
      this.pastTools.push(signature);
    }
    const s = start ?? this.nowFn() - d;
    const e = end ?? s + d;
    this.toolIntervals.push({ start: s, end: e });
  }

  public recordVerificationSpan(durationMs: number, start?: number, end?: number): void {
    const d = Math.max(0, durationMs);
    this.verificationDurationMs += d;
    const s = start ?? this.nowFn() - d;
    const e = end ?? s + d;
    this.verificationIntervals.push({ start: s, end: e });
  }

  public recordCriticSpan(durationMs: number, start?: number, end?: number): void {
    const d = Math.max(0, durationMs);
    this.criticDurationMs += d;
    const s = start ?? this.nowFn() - d;
    const e = end ?? s + d;
    this.criticIntervals.push({ start: s, end: e });
  }

  public recordCompactionSpan(durationMs: number, start?: number, end?: number): void {
    const d = Math.max(0, durationMs);
    this.compactionDurationMs += d;
    const s = start ?? this.nowFn() - d;
    const e = end ?? s + d;
    this.compactionIntervals.push({ start: s, end: e });
  }

  public recordPolicyIntervention(): void {
    this.policyInterventions += 1;
  }

  public finalize(opts: {
    turnId: string;
    taskClass: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
    cumulativeSessionTokens: number;
  }): ChatTurnTelemetryRecord {
    const endedAt = this.nowFn();
    const effectiveStart = this.startedAt || this.submittedAt;
    const totalWallTimeMs = Math.max(0, endedAt - effectiveStart);

    // Overlap-safe productive time computation using union of all active intervals
    const allIntervals = [
      ...this.providerIntervals,
      ...this.toolIntervals,
      ...this.verificationIntervals,
      ...this.criticIntervals,
      ...this.compactionIntervals,
    ];
    const productiveUnionMs = computeIntervalUnionDuration(allIntervals);
    const orchestrationOverheadMs = Math.max(0, totalWallTimeMs - productiveUnionMs);
    const ttftMs =
      this.firstTokenAt !== null ? Math.max(0, this.firstTokenAt - this.submittedAt) : null;

    return {
      turnId: opts.turnId,
      taskClass: opts.taskClass,
      timing: {
        submittedAt: this.submittedAt,
        startedAt: this.startedAt,
        firstTokenAt: this.firstTokenAt,
        ttftMs,
        providerDurationMs: this.providerDurationMs,
        toolDurationMs: this.toolDurationMs,
        verificationDurationMs: this.verificationDurationMs,
        criticDurationMs: this.criticDurationMs,
        compactionDurationMs: this.compactionDurationMs,
        orchestrationOverheadMs,
        totalWallTimeMs,
      },
      counts: {
        modelInvocations: this.modelInvocations,
        toolCalls: this.toolCalls,
        successfulToolCalls: this.successfulToolCalls,
        failedToolCalls: this.failedToolCalls,
        repeatedToolCalls: this.repeatedToolCalls,
        policyInterventions: this.policyInterventions,
      },
      promptTokens: opts.promptTokens ?? null,
      completionTokens: opts.completionTokens ?? null,
      cumulativeSessionTokens: opts.cumulativeSessionTokens,
    };
  }
}

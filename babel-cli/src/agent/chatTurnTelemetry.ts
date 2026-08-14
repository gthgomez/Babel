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

export interface ChatTurnTimingBreakdown {
  /** Timestamp when user submitted the turn (ms since epoch) */
  submittedAt: number;
  /** Timestamp when turn started processing (ms) */
  startedAt: number;
  /** Timestamp of first visible token / stream event (ms) */
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

  constructor(submittedAt?: number) {
    this.submittedAt = submittedAt ?? Date.now();
  }

  public markStarted(): void {
    this.startedAt = Date.now();
  }

  public markFirstToken(): void {
    if (this.firstTokenAt === null) {
      this.firstTokenAt = Date.now();
    }
  }

  public recordProviderSpan(durationMs: number): void {
    this.providerDurationMs += Math.max(0, durationMs);
    this.modelInvocations += 1;
  }

  public recordToolSpan(toolName: string, target: string, durationMs: number, success: boolean): void {
    this.toolDurationMs += Math.max(0, durationMs);
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
  }

  public recordVerificationSpan(durationMs: number): void {
    this.verificationDurationMs += Math.max(0, durationMs);
  }

  public recordCriticSpan(durationMs: number): void {
    this.criticDurationMs += Math.max(0, durationMs);
  }

  public recordCompactionSpan(durationMs: number): void {
    this.compactionDurationMs += Math.max(0, durationMs);
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
    const endedAt = Date.now();
    const totalWallTimeMs = Math.max(0, endedAt - (this.startedAt || this.submittedAt));
    const productiveTimeMs =
      this.providerDurationMs +
      this.toolDurationMs +
      this.verificationDurationMs +
      this.criticDurationMs +
      this.compactionDurationMs;

    const orchestrationOverheadMs = Math.max(0, totalWallTimeMs - productiveTimeMs);
    const ttftMs =
      this.firstTokenAt !== null ? Math.max(0, this.firstTokenAt - this.submittedAt) : null;

    return {
      turnId: opts.turnId,
      taskClass: opts.taskClass,
      timing: {
        submittedAt: this.submittedAt,
        startedAt: this.startedAt || this.submittedAt,
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

/**
 * VoicePipelineMetrics — Observability hooks for the voice dictation pipeline.
 *
 * Records microsecond-precision timestamps at every pipeline stage using
 * performance.now(). Produces OpenTelemetry-compatible span structures
 * for export to existing Babel observability infrastructure.
 *
 * @module voice/voice-pipeline-metrics
 */

import type { VoicePipelineSpan, OtelSpan, VoicePhase } from './types.js';

// ── VoicePipelineMetrics ────────────────────────────────────────────────────

export class VoicePipelineMetrics {
  private currentSpan: VoicePipelineSpan | null = null;
  private completedSpans: VoicePipelineSpan[] = [];
  private readonly MAX_COMPLETED_SPANS = 100;

  // ── Span lifecycle ──────────────────────────────────────────────────────

  /**
   * Begin a new trace span for this voice session.
   */
  startSpan(sessionId: string): VoicePipelineSpan {
    const span: VoicePipelineSpan = {
      spanId: crypto.randomUUID(),
      sessionId,
      audioCaptureStart: performance.now(),
      audioCaptureEnd: 0,
      firstSttTokenAt: 0,
      sttCompleteAt: 0,
      llmStartAt: 0,
      llmCompleteAt: 0,
      rawInjectedAt: 0,
      refinedInjectedAt: 0,
      phaseTransitions: [],
    };
    this.currentSpan = span;
    return span;
  }

  /**
   * Record a phase transition with microsecond-precision timestamp.
   */
  recordPhaseTransition(phase: VoicePhase): void {
    if (!this.currentSpan) return;
    this.currentSpan.phaseTransitions.push({
      phase,
      at: performance.now(),
    });
  }

  /**
   * Record the moment audio capture ended.
   */
  recordAudioCaptureEnd(): void {
    if (!this.currentSpan) return;
    this.currentSpan.audioCaptureEnd = performance.now();
  }

  /**
   * Record arrival of the first STT token.
   */
  recordFirstSttToken(): void {
    if (!this.currentSpan) return;
    this.currentSpan.firstSttTokenAt = performance.now();
  }

  /**
   * Record STT completion.
   */
  recordSttComplete(): void {
    if (!this.currentSpan) return;
    this.currentSpan.sttCompleteAt = performance.now();
  }

  /**
   * Record LLM refinement start.
   */
  recordLlmStart(): void {
    if (!this.currentSpan) return;
    this.currentSpan.llmStartAt = performance.now();
  }

  /**
   * Record LLM refinement completion.
   */
  recordLlmComplete(): void {
    if (!this.currentSpan) return;
    this.currentSpan.llmCompleteAt = performance.now();
  }

  /**
   * Record raw text injection into PromptInput.
   */
  recordRawInjection(): void {
    if (!this.currentSpan) return;
    this.currentSpan.rawInjectedAt = performance.now();
  }

  /**
   * Record refined text replacement in PromptInput.
   */
  recordRefinedInjection(): void {
    if (!this.currentSpan) return;
    this.currentSpan.refinedInjectedAt = performance.now();
  }

  /**
   * Record an abort with reason.
   */
  recordAbort(reason: string): void {
    if (!this.currentSpan) return;
    this.currentSpan.abortReason = reason;
  }

  /**
   * Finalise the span and add to the completed span buffer.
   */
  finalizeSpan(): VoicePipelineSpan {
    if (!this.currentSpan) {
      return {
        spanId: '',
        sessionId: '',
        audioCaptureStart: 0,
        audioCaptureEnd: 0,
        firstSttTokenAt: 0,
        sttCompleteAt: 0,
        llmStartAt: 0,
        llmCompleteAt: 0,
        rawInjectedAt: 0,
        refinedInjectedAt: 0,
        phaseTransitions: [],
      };
    }

    const span = this.currentSpan;
    this.currentSpan = null;

    // Store in circular buffer
    this.completedSpans.push(span);
    if (this.completedSpans.length > this.MAX_COMPLETED_SPANS) {
      this.completedSpans.shift();
    }

    return span;
  }

  // ── Computed metrics ────────────────────────────────────────────────────

  /**
   * Compute latency breakdown from the current span.
   */
  getLatencyBreakdown(span?: VoicePipelineSpan): Record<string, number> {
    const s = span ?? this.currentSpan;
    if (!s) return {};

    return {
      /** Total capture duration (ms). */
      captureDurationMs: s.audioCaptureEnd - s.audioCaptureStart,
      /** Time-to-first-token (ms). */
      ttftMs: s.firstSttTokenAt - s.audioCaptureStart,
      /** STT processing time (ms). */
      sttDurationMs: s.sttCompleteAt - s.firstSttTokenAt,
      /** LLM refinement time (ms). */
      llmDurationMs: s.llmCompleteAt - s.llmStartAt,
      /** Total end-to-end time (ms). */
      totalE2EMs: (s.refinedInjectedAt || s.rawInjectedAt) - s.audioCaptureStart,
    };
  }

  // ── OTel export ─────────────────────────────────────────────────────────

  /**
   * Convert a span to OpenTelemetry-compatible format.
   */
  toOtelSpan(span: VoicePipelineSpan): OtelSpan {
    const events: OtelSpan['events'] = [];

    for (const transition of span.phaseTransitions) {
      events.push({
        name: `voice.phase.${transition.phase.toLowerCase()}`,
        timestamp: transition.at,
      });
    }

    // Add specific stage completion events
    if (span.firstSttTokenAt > 0) {
      events.push({
        name: 'voice.stt.first_token',
        timestamp: span.firstSttTokenAt,
      });
    }
    if (span.sttCompleteAt > 0) {
      events.push({
        name: 'voice.stt.complete',
        timestamp: span.sttCompleteAt,
      });
    }
    if (span.rawInjectedAt > 0) {
      events.push({
        name: 'voice.tui.raw_injected',
        timestamp: span.rawInjectedAt,
      });
    }
    if (span.refinedInjectedAt > 0) {
      events.push({
        name: 'voice.tui.refined_injected',
        timestamp: span.refinedInjectedAt,
      });
    }

    const breakdown = this.getLatencyBreakdown(span);

    return {
      traceId: span.sessionId,
      spanId: span.spanId,
      name: 'voice.dictation',
      startTime: span.audioCaptureStart,
      endTime: span.refinedInjectedAt || span.rawInjectedAt || span.audioCaptureEnd,
      attributes: {
        'voice.session_id': span.sessionId,
        'voice.capture_duration_ms': breakdown.captureDurationMs ?? 0,
        'voice.ttft_ms': breakdown.ttftMs ?? 0,
        'voice.stt_duration_ms': breakdown.sttDurationMs ?? 0,
        'voice.llm_duration_ms': breakdown.llmDurationMs ?? 0,
        'voice.total_e2e_ms': breakdown.totalE2EMs ?? 0,
        'voice.aborted': span.abortReason ? 1 : 0,
        'voice.abort_reason': span.abortReason ?? '',
        'voice.phase_count': span.phaseTransitions.length,
      },
      events,
    };
  }

  // ── History ─────────────────────────────────────────────────────────────

  /**
   * Get all completed spans (up to MAX_COMPLETED_SPANS).
   */
  getCompletedSpans(): readonly VoicePipelineSpan[] {
    return this.completedSpans;
  }

  /**
   * Get the most recent N spans.
   */
  getRecentSpans(n: number = 10): readonly VoicePipelineSpan[] {
    return this.completedSpans.slice(-n);
  }
}

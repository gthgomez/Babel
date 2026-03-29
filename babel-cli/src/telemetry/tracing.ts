import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type BaggageEntry,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { hashOrderedIds, hashText } from './hash.js';
import type { HarnessMetadata } from './metadata.js';

const TRACE_SCHEMA_VERSION = '1';
const TELEMETRY_NAME = 'babel-cli';
const TELEMETRY_VERSION = '1.0.0';
const EVIDENCE_GATE_UNKNOWN = 'unknown';

export interface TraceContextSummary {
  enabled: boolean;
  schema_version: string;
  trace_id?: string;
  root_span_id?: string;
  trace_flags?: string;
  otel_service_name?: string;
  baggage: Record<string, string>;
}

export interface StartRunTraceOptions {
  runDir: string;
  orchestratorVersion: string;
  requestedMode?: string;
  sessionId?: string;
  sessionStartPath?: string;
  localLearningRoot?: string;
  metadata: HarnessMetadata;
}

interface TelemetryRuntime {
  enabled: boolean;
  serviceName: string;
  tracer: Tracer;
  provider: NodeTracerProvider | null;
}

let activeRuntimeKey = '';
let activeRuntime: TelemetryRuntime | null = null;
let activeInMemoryExporter: InMemorySpanExporter | null = null;
let inMemoryTestMode = false;

function truthyEnv(name: string): boolean {
  return process.env[name] === 'true';
}

function buildRuntimeKey(): string {
  return JSON.stringify({
    enabled: truthyEnv('BABEL_OTEL_ENABLED'),
    serviceName: process.env['BABEL_OTEL_SERVICE_NAME'] ?? TELEMETRY_NAME,
    endpoint: process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '',
    inMemoryTestMode,
  });
}

async function shutdownActiveRuntime(): Promise<void> {
  if (activeRuntime?.provider) {
    await activeRuntime.provider.shutdown();
  }

  activeRuntimeKey = '';
  activeRuntime = null;
  activeInMemoryExporter = null;
}

function normalizeAttributes(attributes: Attributes): Attributes {
  const normalized: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.every(item => typeof item === 'string')) {
        normalized[key] = value;
        continue;
      }
      if (value.every(item => typeof item === 'number')) {
        normalized[key] = value;
        continue;
      }
      if (value.every(item => typeof item === 'boolean')) {
        normalized[key] = value;
      }
      continue;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      normalized[key] = value;
    }
  }

  return normalized;
}

async function ensureTelemetryRuntime(): Promise<TelemetryRuntime> {
  const key = buildRuntimeKey();
  if (activeRuntime && activeRuntimeKey === key) {
    return activeRuntime;
  }

  await shutdownActiveRuntime();

  const enabled = truthyEnv('BABEL_OTEL_ENABLED');
  const serviceName = (process.env['BABEL_OTEL_SERVICE_NAME'] ?? TELEMETRY_NAME).trim() || TELEMETRY_NAME;

  if (!enabled) {
    activeRuntimeKey = key;
    activeRuntime = {
      enabled: false,
      serviceName,
      tracer: trace.getTracer(TELEMETRY_NAME, TELEMETRY_VERSION),
      provider: null,
    };
    return activeRuntime;
  }

  const spanProcessors = [];
  const exporterEndpoint = process.env['BABEL_OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (exporterEndpoint) {
    const exporter = new OTLPTraceExporter({ url: exporterEndpoint });
    spanProcessors.push(new SimpleSpanProcessor(exporter));
  } else if (!inMemoryTestMode) {
    console.warn(
      '[babel:telemetry] BABEL_OTEL_ENABLED=true but BABEL_OTEL_EXPORTER_OTLP_ENDPOINT is not set' +
      ' — no spans will be exported. Set the endpoint or disable tracing.',
    );
  }

  if (inMemoryTestMode) {
    activeInMemoryExporter = new InMemorySpanExporter();
    spanProcessors.push(new SimpleSpanProcessor(activeInMemoryExporter));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    spanProcessors,
  });
  provider.register();

  activeRuntimeKey = key;
  activeRuntime = {
    enabled: true,
    serviceName,
    tracer: trace.getTracer(TELEMETRY_NAME, TELEMETRY_VERSION),
    provider,
  };

  return activeRuntime;
}

function baggageEntriesToRecord(ctx: Context): Record<string, string> {
  const baggage = propagation.getBaggage(ctx);
  if (!baggage) {
    return {};
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of baggage.getAllEntries()) {
    record[key] = entry.value;
  }
  return record;
}

function createBaggageEntry(value: string): BaggageEntry {
  return { value };
}

function buildInitialBaggage(
  laneId: string,
  metadata: HarnessMetadata,
): Record<string, BaggageEntry> {
  const entries: Record<string, BaggageEntry> = {
    'babel.lane.id': createBaggageEntry(laneId),
    'babel.evidence_gate.status': createBaggageEntry(EVIDENCE_GATE_UNKNOWN),
  };

  if (metadata.policyVersionApplied) {
    entries['babel.policy.version'] = createBaggageEntry(metadata.policyVersionApplied);
  }

  return entries;
}

function buildRootAttributes(options: StartRunTraceOptions): Attributes {
  const runId = options.runDir.split(/[\\/]/).pop() ?? options.runDir;

  return normalizeAttributes({
    'babel.run.id': runId,
    'babel.run.mode.requested': options.requestedMode ?? 'unspecified',
    'babel.run.orchestrator_version': options.orchestratorVersion,
    'babel.session.id': options.sessionId,
    'babel.session.has_local_learning_root': options.metadata.hasLocalLearningRoot,
    'babel.trace.schema_version': TRACE_SCHEMA_VERSION,
    'ci.provider': options.metadata.ciProvider,
    'ci.run_id': options.metadata.ciRunId,
    'ci.run_url': options.metadata.ciRunUrl,
    'vcs.repository': options.metadata.vcsRepository,
    'vcs.ref': options.metadata.vcsRef,
    'vcs.sha': options.metadata.vcsSha,
    'pull_request.number': options.metadata.pullRequestNumber,
    'deploy.environment': options.metadata.deployEnvironment,
    'deploy.id': options.metadata.deployId,
    'deploy.trigger': options.metadata.deployTrigger,
    'babel.policy.version': options.metadata.policyVersionApplied,
    'babel.active_policy_ids_hash': options.metadata.activePolicyIdsHash,
    'babel.recommended_stack_ids_hash': options.metadata.recommendedStackIdsHash,
    'babel.session_start_path_hash': options.metadata.sessionStartPathHash,
    'babel.local_learning_root_hash': options.metadata.localLearningRootHash,
  });
}

export class PipelineTrace {
  private readonly runtime: TelemetryRuntime;
  private readonly rootSpan: Span | null;
  private baggageContext: Context;
  private spanContext: Context;
  private ended = false;

  private constructor(
    runtime: TelemetryRuntime,
    rootSpan: Span | null,
    baggageContext: Context,
    spanContext: Context,
  ) {
    this.runtime = runtime;
    this.rootSpan = rootSpan;
    this.baggageContext = baggageContext;
    this.spanContext = spanContext;
  }

  static async start(options: StartRunTraceOptions): Promise<PipelineTrace> {
    const runtime = await ensureTelemetryRuntime();
    if (!runtime.enabled) {
      return new PipelineTrace(runtime, null, ROOT_CONTEXT, ROOT_CONTEXT);
    }

    const laneId = `${options.orchestratorVersion}:${options.requestedMode ?? 'unspecified'}`;
    const baggage = propagation.createBaggage(buildInitialBaggage(laneId, options.metadata));
    const baggageContext = propagation.setBaggage(ROOT_CONTEXT, baggage);
    const rootSpan = runtime.tracer.startSpan(
      'babel.run',
      { attributes: buildRootAttributes(options) },
      baggageContext,
    );
    rootSpan.addEvent('run.start');

    return new PipelineTrace(
      runtime,
      rootSpan,
      baggageContext,
      trace.setSpan(baggageContext, rootSpan),
    );
  }

  get enabled(): boolean {
    return this.runtime.enabled && this.rootSpan !== null;
  }

  startChildSpan(name: string, attributes: Attributes = {}): Span | null {
    if (!this.rootSpan) {
      return null;
    }

    return this.runtime.tracer.startSpan(
      name,
      { attributes: normalizeAttributes(attributes) },
      this.spanContext,
    );
  }

  setRootAttributes(attributes: Attributes): void {
    this.rootSpan?.setAttributes(normalizeAttributes(attributes));
  }

  addRootEvent(name: string, attributes: Attributes = {}): void {
    this.rootSpan?.addEvent(name, normalizeAttributes(attributes));
  }

  updateBaggage(values: Record<string, string | undefined>): void {
    if (!this.rootSpan) {
      return;
    }

    const current = propagation.getBaggage(this.baggageContext);
    const nextEntries: Record<string, BaggageEntry> = {};

    if (current) {
      for (const [key, entry] of current.getAllEntries()) {
        nextEntries[key] = entry;
      }
    }

    for (const [key, value] of Object.entries(values)) {
      if (!value) {
        continue;
      }
      nextEntries[key] = createBaggageEntry(value);
    }

    const baggage = propagation.createBaggage(nextEntries);
    this.baggageContext = propagation.setBaggage(ROOT_CONTEXT, baggage);
    this.spanContext = trace.setSpan(this.baggageContext, this.rootSpan);
  }

  recordCompilerSummary(summary: {
    domainId?: string;
    modelAdapterId?: string;
    selectedEntryIds?: string[];
    promptManifestCount?: number;
    skillCount?: number;
    tokenBudgetTotal?: number | null;
    tokenBudgetMissingCount?: number;
    budgetWarningSeverity?: string | null;
    budgetPolicyEnabled?: boolean;
  }): void {
    this.setRootAttributes(normalizeAttributes({
      'babel.stack.domain_id': summary.domainId,
      'babel.stack.model_adapter_id': summary.modelAdapterId,
      'babel.stack.selected_entry_count': summary.selectedEntryIds?.length,
      'babel.stack.selected_entry_ids_hash': summary.selectedEntryIds ? hashOrderedIds(summary.selectedEntryIds) : undefined,
      'babel.stack.prompt_manifest_count': summary.promptManifestCount,
      'babel.stack.skill_count': summary.skillCount,
      'babel.stack.token_budget_total': summary.tokenBudgetTotal ?? undefined,
      'babel.stack.token_budget_missing_count': summary.tokenBudgetMissingCount,
      'babel.stack.budget_warning_severity': summary.budgetWarningSeverity ?? undefined,
      'babel.stack.budget_policy_enabled': summary.budgetPolicyEnabled,
    }));
  }

  recordQaVerdict(verdict: 'PASS' | 'REJECT', failureTags: string[]): void {
    const evidenceGateStatus =
      verdict === 'PASS'
        ? 'satisfied'
        : (failureTags.includes('EVIDENCE-GATE') ? 'violated' : EVIDENCE_GATE_UNKNOWN);

    this.updateBaggage({
      'babel.evidence_gate.status': evidenceGateStatus,
    });

    this.setRootAttributes({
      'babel.qa.verdict': verdict,
      'babel.qa.failure_count': failureTags.length,
      'babel.qa.failure_tags_hash': failureTags.length > 0 ? hashOrderedIds(failureTags) : undefined,
      'babel.evidence_gate.status': evidenceGateStatus,
    });
  }

  writeSummary(): TraceContextSummary {
    if (!this.rootSpan) {
      return {
        enabled: false,
        schema_version: TRACE_SCHEMA_VERSION,
        baggage: {},
      };
    }

    const spanContext = this.rootSpan.spanContext();
    return {
      enabled: true,
      schema_version: TRACE_SCHEMA_VERSION,
      trace_id: spanContext.traceId,
      root_span_id: spanContext.spanId,
      trace_flags: spanContext.traceFlags.toString(16).padStart(2, '0'),
      otel_service_name: this.runtime.serviceName,
      baggage: baggageEntriesToRecord(this.spanContext),
    };
  }

  async finish(finalStatus: string, error?: unknown): Promise<TraceContextSummary> {
    if (!this.rootSpan || this.ended) {
      return this.writeSummary();
    }

    if (error) {
      this.rootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
      this.rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.rootSpan.addEvent('run.halt', { 'babel.final_status': finalStatus });
    } else {
      this.rootSpan.setStatus({ code: SpanStatusCode.OK });
      this.rootSpan.addEvent('run.complete', { 'babel.final_status': finalStatus });
    }

    this.rootSpan.setAttribute('babel.final_status', finalStatus);
    this.rootSpan.end();
    this.ended = true;

    if (this.runtime.provider) {
      await this.runtime.provider.forceFlush();
    }

    return this.writeSummary();
  }
}

export function endSpan(
  span: Span | null,
  status: SpanStatusCode,
  attributes: Attributes = {},
  error?: unknown,
): void {
  if (!span) {
    return;
  }

  span.setAttributes(normalizeAttributes(attributes));
  if (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({
      code: status,
      message: error instanceof Error ? error.message : String(error),
    });
  } else {
    span.setStatus({ code: status });
  }
  span.end();
}

export async function resetTelemetryForTests(): Promise<void> {
  inMemoryTestMode = false;
  await shutdownActiveRuntime();
}

export async function enableInMemoryTelemetryForTests(): Promise<void> {
  inMemoryTestMode = true;
  await shutdownActiveRuntime();
}

export function getFinishedTestSpans(): ReadableSpan[] {
  return activeInMemoryExporter?.getFinishedSpans() ?? [];
}

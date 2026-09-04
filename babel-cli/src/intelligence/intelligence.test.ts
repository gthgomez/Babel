import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { z } from "zod";
import { OpenRouterApiRunner } from "../runners/openRouterApi.js";
import {
  createHarnessTuningProfile,
  createLabModelSpec,
  createProviderModelProfile,
  detectProviderProfileDrift,
  qualificationStaleness,
} from "./profiles.js";
import {
  buildCampaignReadiness,
  CampaignCircuitBreaker,
  buildAggregateMetric,
  validateCampaignPreflight,
  modelSuccessAttributable,
} from "./campaignGuards.js";
import {
  normalizeBabelFinishReason,
  normalizeProviderFailure,
} from "./attribution.js";
import {
  resolveExecutionEnvelope,
  resolveModelRevision,
  assertModelRevisionStable,
  ExecutionEnvelopeError,
} from "./resolver.js";
import {
  assertWireRequestMatchesEnvelope,
  buildWireRequestFromEnvelope,
} from "./wire.js";
import {
  calculateContextEnvelope,
  campaignIdentityHash,
  estimateTokenCount,
  resolveAuxiliaryInferencePolicy,
} from "./treatment.js";
import {
  normalizeOpenRouterExecutionObservation,
  validateOpenRouterExecutionObservation,
} from "./routing.js";
import {
  createModelQualificationRecord,
  qualificationCallCeiling,
  runQualificationProbes,
} from "./qualification.js";
import {
  normalizeOpenRouterEndpointMetadata,
  normalizeOpenRouterModelMetadata,
  selectOpenRouterModelEntry,
} from "./openrouterMetadata.js";
import {
  fetchAndPersistOpenRouterModelEvidence,
  redactProviderBody,
} from "./providerEvidence.js";
import { assertAuxiliaryInferenceInventory } from "./inferenceInventory.js";
import {
  createModelRegistry,
  isModelRegistryEntryEligible,
} from "./registry.js";
import { createProviderOperationalProfile } from "./operational.js";
import { DEFAULT_RETRY_POLICY, shouldRetryFailure } from "./retryPolicy.js";
import type { ProtocolProfile } from "./types.js";

function capability(
  state:
    | "api_advertised"
    | "behaviorally_verified"
    | "unknown" = "behaviorally_verified",
) {
  return {
    state,
    support:
      state === "unknown" ? ("unknown" as const) : ("supported" as const),
    evidenceLevel: "api_advertised" as const,
    confidence: state === "unknown" ? ("unknown" as const) : ("high" as const),
  } as const;
}

function protocolProfile(): ProtocolProfile {
  return {
    protocol: "chat_completions",
    streaming: capability(),
    reasoning: {
      enabled: capability(),
      mechanism: "effort",
      supportedEfforts: ["low", "high"],
      semanticEffectEvidence: [],
    },
    tools: {
      basicTools: capability(),
      streamingTools: capability(),
      sequentialTools: capability(),
      parallelTools: capability("unknown"),
      toolChoiceAuto: capability(),
      toolChoiceRequired: capability(),
      toolChoiceSpecific: capability("unknown"),
      strictArgumentSchema: capability("unknown"),
      reasoningToolInterleave: capability("unknown"),
      reasoningReplayAcrossTurns: capability("unknown"),
      multipleToolRounds: capability("unknown"),
    },
    structuredOutput: {
      jsonObjectMode: capability(),
      jsonSchemaMode: capability("unknown"),
      strictSchemaEnforcement: capability("unknown"),
      structuredOutputWithTools: capability("unknown"),
      structuredOutputStreaming: capability("unknown"),
    },
    supportedParameters: [
      {
        canonicalParameter: "max_tokens",
        wireParameter: "max_tokens",
        state: "behaviorally_verified",
      },
      {
        canonicalParameter: "reasoning_effort",
        wireParameter: "reasoning_effort",
        state: "api_advertised",
      },
      {
        canonicalParameter: "temperature",
        wireParameter: "temperature",
        state: "api_advertised",
      },
      {
        canonicalParameter: "top_p",
        wireParameter: "top_p",
        state: "api_advertised",
      },
      {
        canonicalParameter: "seed",
        wireParameter: "seed",
        state: "api_advertised",
      },
    ],
    qualificationStatus: "partially_qualified",
  };
}

function profiles() {
  const labModel = createLabModelSpec({
    schemaVersion: 1,
    canonicalModelId: "z-ai/glm-5.3-flash",
    family: "z-ai",
    revision: "20260826",
    modalities: { input: ["text"], output: ["text"] },
    declaredLimits: { contextTokens: 1310720, maxOutputTokens: 131072 },
    nativeCapabilities: {
      reasoning: capability("api_advertised"),
      tools: capability("api_advertised"),
    },
    sourceEvidence: [],
  });
  const providerProfile = createProviderModelProfile({
    schemaVersion: 1,
    provider: "openrouter",
    canonicalModelId: labModel.canonicalModelId,
    providerModelId: labModel.canonicalModelId,
    upstreamProvider: "ExampleProvider",
    endpointId: "example-endpoint",
    protocolProfiles: [protocolProfile()],
    providerLimits: { contextTokens: 1048576, maxOutputTokens: 65536 },
    pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
    lifecycle: { status: "active" },
    sourceEvidence: [],
    observedEvidence: [],
  });
  const harnessProfile = createHarnessTuningProfile({
    schemaVersion: 1,
    modelProfileHash: labModel.profileHash,
    status: "provisional",
    outputBudgetPolicy: { smoke: 1024, normalRepoTask: 8192 },
    contextStrategy: { strategy: "hybrid" },
    evidence: [],
  });
  return { labModel, providerProfile, harnessProfile };
}

function strictEnvelope() {
  const { labModel, providerProfile, harnessProfile } = profiles();
  return resolveExecutionEnvelope({
    mode: "benchmark_strict",
    model: { requested: "z-ai/glm-5.3-flash" },
    labModel,
    providerProfile,
    harnessProfile,
    output: { requested: 8192 },
    reasoning: { requestedEffort: "high" },
    tools: { enabled: true, choice: "required" },
    structuredOutput: { mode: "json_object" },
    routing: { upstream: "ExampleProvider", order: ["ExampleProvider"] },
    affordability: { promptTokens: 1000, cells: 1, maxEstimatedCostUsd: 1 },
  });
}

test("separates model facts from provider-hosted facts and changes identity on material drift", () => {
  const { labModel, providerProfile } = profiles();
  const changed = createProviderModelProfile({
    ...providerProfile,
    providerLimits: {
      ...providerProfile.providerLimits,
      maxOutputTokens: 32768,
    },
  });
  const drift = detectProviderProfileDrift(providerProfile, changed);
  assert.equal(drift.changed, true);
  assert.deepEqual(drift.fields, ["providerLimits"]);
  assert.deepEqual(
    qualificationStaleness(
      {
        modelProfileHash: labModel.profileHash,
        providerProfileHash: providerProfile.profileHash,
      },
      {
        modelProfileHash: labModel.profileHash,
        profileHash: changed.profileHash,
      },
    ),
    { stale: true, reason: "provider model profile changed" },
  );
});

test("keeps profile hashes stable across retrieval timestamps but changes them on material drift", () => {
  const { providerProfile: base } = profiles();
  const providerProfile = createProviderModelProfile({
    ...base,
    sourceEvidence: [
      { source: "provider_api", retrievedAt: "2026-08-29T00:00:00.000Z" },
    ],
  });
  const refreshed = createProviderModelProfile({
    ...providerProfile,
    sourceEvidence: [
      { source: "provider_api", retrievedAt: "2026-08-30T00:00:00.000Z" },
    ],
  });
  assert.equal(refreshed.profileHash, providerProfile.profileHash);
  const changed = createProviderModelProfile({
    ...refreshed,
    providerLimits: { ...refreshed.providerLimits, maxOutputTokens: 32768 },
  });
  assert.notEqual(changed.profileHash, providerProfile.profileHash);
});

test("fails closed for benchmark output overflow and explicitly clamps only resilient production", () => {
  const { labModel, providerProfile } = profiles();
  assert.throws(
    () =>
      resolveExecutionEnvelope({
        mode: "benchmark_strict",
        model: { requested: labModel.canonicalModelId },
        labModel,
        providerProfile,
        output: { requested: 90000 },
        routing: { upstream: "ExampleProvider" },
      }),
    (error: unknown) =>
      error instanceof ExecutionEnvelopeError &&
      error.details.resolution === "rejected",
  );
  const envelope = resolveExecutionEnvelope({
    mode: "production_resilient",
    model: { requested: labModel.canonicalModelId },
    labModel,
    providerProfile,
    output: { requested: 90000, allowProductionClamp: true },
  });
  assert.equal(envelope.output.effective, 65536);
  assert.equal(envelope.output.resolution, "clamped");
});

test("requires an explicit concrete revision for aliases and rejects alias drift", () => {
  const resolved = resolveModelRevision({
    requested: "~deepseek/deepseek-v4-flash-latest",
    aliases: {
      "~deepseek/deepseek-v4-flash-latest": "deepseek/deepseek-v4-flash-0731",
    },
  });
  assert.equal(resolved.resolved, "deepseek/deepseek-v4-flash-0731");
  assert.throws(
    () =>
      assertModelRevisionStable(resolved, {
        requested: resolved.requested,
        resolved: "deepseek/deepseek-v4-flash-0813",
      }),
    /revision drift/,
  );
  assert.throws(
    () => resolveModelRevision({ requested: "~missing/latest" }),
    /no concrete revision mapping/,
  );
});

test("serializes only resolved policy and detects SDK parameter drops", () => {
  const envelope = strictEnvelope();
  assert.equal(Object.isFrozen(envelope), true);
  const wire = buildWireRequestFromEnvelope(envelope, {
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: { name: "lookup", description: "lookup", parameters: {} },
      },
    ],
    toolChoice: "required",
  });
  assert.equal(wire.model, "z-ai/glm-5.3-flash");
  assert.equal(wire.max_tokens, 8192);
  assert.equal(wire.reasoning_effort, "high");
  assert.equal(wire.provider?.allow_fallbacks, false);
  assert.equal(wire.provider?.require_parameters, true);
  assert.doesNotThrow(() =>
    assertWireRequestMatchesEnvelope(
      wire as unknown as Record<string, unknown>,
      envelope,
    ),
  );
  assert.throws(
    () =>
      assertWireRequestMatchesEnvelope(
        { ...wire, reasoning_effort: undefined } as unknown as Record<
          string,
          unknown
        >,
        envelope,
      ),
    /reasoning effort/,
  );
});

test("treats sampling controls as explicit capability decisions", () => {
  const { labModel, providerProfile } = profiles();
  const envelope = resolveExecutionEnvelope({
    mode: "benchmark_strict",
    model: { requested: labModel.canonicalModelId },
    labModel,
    providerProfile,
    output: { requested: 1024 },
    sampling: { temperature: 0, topP: 0.8, seed: 7 },
    routing: { upstream: "ExampleProvider" },
  });
  assert.equal(envelope.sampling.temperature?.accepted, false);
  assert.equal(envelope.sampling.temperature?.semanticEffectVerified, false);
  const wire = buildWireRequestFromEnvelope(envelope, {
    stream: false,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(wire.temperature, 0);
  assert.equal(wire.top_p, 0.8);
  assert.equal(wire.seed, 7);
  assert.doesNotThrow(() =>
    assertWireRequestMatchesEnvelope(
      wire as unknown as Record<string, unknown>,
      envelope,
    ),
  );
});

test("keeps accepted reasoning separate from semantic verification", () => {
  const { labModel, providerProfile } = profiles();
  const envelope = resolveExecutionEnvelope({
    mode: "qualification",
    model: { requested: labModel.canonicalModelId },
    labModel,
    providerProfile,
    output: { requested: 4096 },
    reasoning: { requestedEffort: "low" },
  });
  assert.equal(envelope.reasoning.resolution, "pass");
  assert.equal(envelope.reasoning.semanticEffectVerified, false);
});

test("normalizes output exhaustion and keeps 402 out of the retry-after-delay path", () => {
  const exhausted = normalizeBabelFinishReason({
    raw: "length",
    configuredOutputBudget: 8192,
    actualCompletionTokens: 8192,
  });
  assert.equal(exhausted.normalized, "OUTPUT_BUDGET_EXHAUSTED");
  assert.equal(exhausted.budgetKind, "HARNESS_OUTPUT_TOKEN_BUDGET_EXHAUSTED");
  assert.equal(exhausted.attribution.kind, "HARNESS_POLICY_CONSTRAINT");
  const natural = normalizeBabelFinishReason({
    raw: "stop",
    configuredOutputBudget: 8192,
    actualCompletionTokens: 7900,
  });
  assert.equal(natural.normalized, "NATURAL_COMPLETION");
  assert.deepEqual(
    normalizeProviderFailure({ status: 402, message: "insufficient credits" }),
    {
      failureClass: "INSUFFICIENT_CREDITS",
      retryability: "retryable_after_account_change",
    },
  );
  assert.equal(
    shouldRetryFailure(DEFAULT_RETRY_POLICY, {
      failureClass: "RATE_LIMITED",
      retryability: "retryable_after_delay",
    }),
    true,
  );
  assert.equal(
    shouldRetryFailure(DEFAULT_RETRY_POLICY, {
      failureClass: "INSUFFICIENT_CREDITS",
      retryability: "retryable_after_account_change",
    }),
    false,
  );
});

test("opens the campaign circuit on systemic credit failure and prevents matching fan-out", () => {
  const breaker = new CampaignCircuitBreaker({ transientFailureThreshold: 2 });
  const snapshot = breaker.observeFailure({
    failure: {
      provider: "openrouter",
      executionEnvelopeHash: "env-1",
      normalizedFailureClass: "INSUFFICIENT_CREDITS",
      httpStatus: 402,
      configurationRelevant: true,
      retryableWithoutChange: false,
    },
    model: "glm",
    estimatedCellCostUsd: 0.12,
  });
  assert.equal(snapshot.state, "OPEN");
  breaker.recordPreventedCell(0.12);
  assert.equal(breaker.snapshot().cellsPrevented, 1);
  assert.throws(() => breaker.assertCanDispatch(), /OPEN/);
});

test("separates readiness, diagnostic metrics, and solved-task attribution", () => {
  const readiness = buildCampaignReadiness({
    telemetryComplete: true,
    providerFailures: 24,
    cleanComparableCells: 0,
  });
  assert.equal(readiness.instrumentation.status, "READY");
  assert.notEqual(readiness.execution.status, "READY");
  assert.equal(readiness.comparison.status, "INVALID");
  const metric = buildAggregateMetric({
    value: 4,
    comparable: false,
    includedCells: ["a"],
    excludedCells: ["b"],
  });
  assert.equal(metric.validity, "diagnostic_only");
  assert.equal(
    modelSuccessAttributable({ taskSolved: true, cleanComparable: false }),
    false,
  );
  assert.equal(
    modelSuccessAttributable({
      taskSolved: true,
      cleanComparable: true,
      attribution: { kind: "UNKNOWN", evidence: [] },
    }),
    false,
  );
});

test("requires the exact representative smoke before paid fan-out", () => {
  const missing = validateCampaignPreflight({
    paidCellCount: 3,
    exactEnvelopeHash: "env-1",
  });
  assert.equal(missing.state, "PRE_FLIGHT_REQUIRED");
  const mismatched = validateCampaignPreflight({
    paidCellCount: 3,
    exactEnvelopeHash: "env-1",
    smokeEnvelopeHash: "env-2",
  });
  assert.equal(mismatched.state, "PRE_FLIGHT_INVALID");
  const valid = validateCampaignPreflight({
    paidCellCount: 3,
    exactEnvelopeHash: "env-1",
    smokeEnvelopeHash: "env-1",
    checks: {
      auth: true,
      affordability: true,
      routing: true,
      modelIdentity: true,
      requiredParameters: true,
      serialization: true,
      receipts: true,
    },
  });
  assert.equal(valid.state, "PRE_FLIGHT_PROVIDER_VALIDATED");
});

test("records token method, context reservations, auxiliary policy, and campaign identity inputs", () => {
  const text = "same prompt";
  const a = estimateTokenCount({
    text,
    tokenizer: () => 2,
    tokenizerName: "a",
  });
  const b = estimateTokenCount({
    text,
    tokenizer: () => 20,
    tokenizerName: "b",
  });
  assert.notEqual(a.tokens, b.tokens);
  const context = calculateContextEnvelope({
    contextLimit: 100,
    reservedOutputTokens: 20,
    reservedReasoningTokens: 10,
    protocolToolOverheadTokens: 5,
    safetyMarginTokens: 5,
  });
  assert.equal(context.maximumAdmissibleInputTokens, 60);
  assert.doesNotThrow(() =>
    resolveAuxiliaryInferencePolicy({
      primaryProviderProfileHash: "primary",
      policy: {
        role: "compaction",
        modelPolicy: { mode: "inherit_primary" },
        experimentalTreatment: "part_of_primary_treatment",
      },
    }),
  );
  assert.notEqual(
    campaignIdentityHash({
      taskHashes: ["a"],
      scheduleSeed: "1",
      scheduleHash: "2",
      babelSha: "3",
      runnerSourceHash: "4",
      analyzerHash: "5",
      packageLockHash: "6",
      buildArtifactHash: "7",
      labModelProfileHash: "8",
      providerModelProfileHash: "9",
      protocolProfileHash: "10",
      harnessTuningProfileHash: "11",
      executionEnvelopeTemplateHash: "12",
      routingPolicyHash: "13",
      auxiliaryInferencePolicyHash: "14",
      tokenEstimationPolicyHash: "15",
      qualificationRecordHash: "16",
    }),
    "",
  );
});

test("strict routing rejects fallback and unexpected upstream from normalized metadata", () => {
  const observation = normalizeOpenRouterExecutionObservation({
    requestedModel: "m",
    resolvedModel: "m",
    requestedProviderPolicy: { allowFallbacks: false, requireParameters: true },
    response: {
      provider: "ProviderB",
      openrouter_metadata: {
        attempts: [
          { provider: "ProviderA", status: 503 },
          { provider: "ProviderB", status: 200 },
        ],
      },
    },
    routerMetadataRequired: true,
  });
  assert.equal(observation.fallbackOccurred, true);
  assert.throws(
    () =>
      validateOpenRouterExecutionObservation({
        mode: "benchmark_strict",
        requestedUpstream: "ProviderA",
        observation,
      }),
    /campaign-invalid/,
  );
});

test("qualification remains blocked until paid probes are explicitly authorized", async () => {
  let executed = 0;
  const results = await runQualificationProbes({
    specs: [
      {
        id: "Q1",
        purpose: "smoke",
        paid: true,
        maxCalls: 1,
        maxOutputTokens: 1024,
        requiredCapabilities: [],
        expectedBehavior: { kind: "smoke" },
        stopOnFailure: true,
      },
    ],
    executor: {
      execute: async () => {
        executed += 1;
        return {
          probeId: "Q1",
          requestArtifactId: "req",
          capabilityEvidence: [],
          status: "pass",
        };
      },
    },
  });
  assert.equal(executed, 0);
  assert.equal(results[0]?.status, "blocked");
  const record = createModelQualificationRecord({
    modelProfileHash: "m",
    providerProfileHash: "p",
    protocol: "chat_completions",
    harnessVersion: "test",
    declaredEvidence: [],
    probes: results,
    createdAt: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(record.overallStatus, "blocked");
  assert.ok(qualificationCallCeiling() >= 1);
});

test("auxiliary inference policy is explicit even when multiple provider keys exist", () => {
  const policies = new Map([
    [
      "compaction",
      {
        role: "compaction" as const,
        modelPolicy: { mode: "inherit_primary" as const },
        experimentalTreatment: "part_of_primary_treatment" as const,
      },
    ],
    [
      "critic",
      {
        role: "critic" as const,
        modelPolicy: {
          mode: "explicit" as const,
          providerProfileHash: "critic-profile",
        },
        experimentalTreatment: "fixed_control" as const,
      },
    ],
    [
      "reviewer",
      {
        role: "reviewer" as const,
        modelPolicy: { mode: "disabled" as const },
        experimentalTreatment: "out_of_band" as const,
      },
    ],
    [
      "summarizer",
      {
        role: "summarizer" as const,
        modelPolicy: { mode: "disabled" as const },
        experimentalTreatment: "out_of_band" as const,
      },
    ],
    [
      "verifier",
      {
        role: "verifier" as const,
        modelPolicy: { mode: "disabled" as const },
        experimentalTreatment: "out_of_band" as const,
      },
    ],
  ]);
  assert.doesNotThrow(() => assertAuxiliaryInferenceInventory(policies));
});

test("normalizes OpenRouter advertised metadata without promoting it to behavioral verification", () => {
  const normalized = normalizeOpenRouterModelMetadata({
    requestedModel: "~deepseek/deepseek-v4-flash-latest",
    observedAt: "2026-08-29T00:00:00.000Z",
    entry: {
      id: "~deepseek/deepseek-v4-flash-latest",
      canonical_slug: "~deepseek/deepseek-v4-flash-latest",
      alias_target: { slug: "deepseek/deepseek-v4-flash-0731" },
      context_length: 1310720,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "Router",
      },
      pricing: { prompt: "0.00000003", completion: "0.0000001" },
      top_provider: { context_length: 1048576, max_completion_tokens: 131072 },
      supported_parameters: [
        "max_tokens",
        "reasoning_effort",
        "tools",
        "tool_choice",
        "structured_outputs",
      ],
      reasoning: {
        mandatory: false,
        supported_efforts: ["max", "high", "low"],
        default_effort: "high",
      },
    },
  });
  assert.equal(normalized.resolvedModel, "deepseek/deepseek-v4-flash-0731");
  assert.equal(normalized.labModel.declaredLimits.maxOutputTokens, undefined);
  assert.equal(normalized.labModel.limitEvidenceStatus, "conflicting");
  assert.equal(
    normalized.providerProfile.providerLimits.maxOutputTokens,
    131072,
  );
  const profile = normalized.providerProfile.protocolProfiles[0]!;
  assert.equal(profile.tools.basicTools.state, "api_advertised");
  assert.equal(profile.tools.parallelTools.state, "unknown");
  assert.equal(profile.qualificationStatus, "unqualified");
});

test("pins OpenRouter concrete revisions from canonical slugs", () => {
  const normalized = normalizeOpenRouterModelMetadata({
    requestedModel: "z-ai/glm-5.3-flash",
    observedAt: "2026-08-29T00:00:00.000Z",
    entry: {
      id: "z-ai/glm-5.3-flash",
      canonical_slug: "z-ai/glm-5.3-flash-20260826",
      context_length: 1310720,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      top_provider: { context_length: 1048576, max_completion_tokens: 131072 },
      supported_parameters: ["max_tokens"],
    },
  });
  assert.equal(normalized.resolvedModel, "z-ai/glm-5.3-flash");
  assert.equal(
    normalized.labModel.canonicalModelId,
    "z-ai/glm-5.3-flash-20260826",
  );
  assert.equal(normalized.labModel.revision, "20260826");
});

test("prefers an exact concrete catalog id over a moving alias target", () => {
  const exact = {
    id: "deepseek/deepseek-v4-flash-0731",
    canonical_slug: "deepseek/deepseek-v4-flash-0731",
  };
  const alias = {
    id: "~deepseek/deepseek-v4-flash-latest",
    alias_target: { slug: "deepseek/deepseek-v4-flash-0731" },
  };
  const selected = selectOpenRouterModelEntry([alias, exact], exact.id);
  assert.equal(selected?.entry.id, exact.id);
  assert.equal(selected?.aliasUsed, false);
  const future = selectOpenRouterModelEntry(
    [
      { ...alias, alias_target: { slug: "deepseek/deepseek-v4-flash-0813" } },
      exact,
    ],
    exact.id,
  );
  assert.deepEqual(future, selected);
});

test("keeps support outcome separate from evidence level and retains raw metadata provenance", async () => {
  assert.equal(
    redactProviderBody('{"authorization":"Bearer secret","data":[1]}'),
    '{\n  "authorization": "[REDACTED]",\n  "data": [\n    1\n  ]\n}',
  );
  const root = await mkdtemp(join(process.cwd(), ".model-intelligence-test-"));
  try {
    const response = await fetchAndPersistOpenRouterModelEvidence({
      requestedModel: "deepseek/deepseek-v4-flash-0731",
      directory: root,
      normalizerSourceHash: "source-hash",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "~deepseek/deepseek-v4-flash-latest",
                alias_target: { slug: "deepseek/deepseek-v4-flash-0731" },
              },
              {
                id: "deepseek/deepseek-v4-flash-0731",
                canonical_slug: "deepseek/deepseek-v4-flash-0731",
                top_provider: { max_completion_tokens: 8192 },
                supported_parameters: ["tools"],
              },
            ],
          }),
          { status: 200, headers: { "x-request-id": "request-1" } },
        ),
    });
    assert.equal(
      response.selection?.entry.id,
      "deepseek/deepseek-v4-flash-0731",
    );
    assert.equal(response.normalized.aliasUsed, false);
    assert.equal(
      response.normalized.labModel.declaredLimits.maxOutputTokens,
      undefined,
    );
    assert.equal(response.evidence.httpStatus, 200);
    assert.equal(response.evidence.normalizerSourceHash, "source-hash");
    assert.equal(response.evidence.rawResponseSha256.length, 64);
    const raw = JSON.parse(await readFile(response.paths.rawPath, "utf8")) as {
      rawResponseBody: string;
    };
    assert.doesNotMatch(raw.rawResponseBody, /Bearer secret/);
    const normalized = JSON.parse(
      await readFile(response.paths.normalizedPath, "utf8"),
    ) as { resolvedModel: string };
    assert.equal(normalized.resolvedModel, "deepseek/deepseek-v4-flash-0731");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps OpenRouter endpoint limits and parameters provider-specific", () => {
  const endpoints = normalizeOpenRouterEndpointMetadata({
    modelId: "z-ai/glm-5.3-flash-20260826",
    observedAt: "2026-08-29T00:00:00.000Z",
    raw: {
      data: {
        endpoints: [
          {
            provider_name: "ExampleProvider",
            tag: "example-fp16",
            context_length: 1048576,
            max_prompt_tokens: 900000,
            max_completion_tokens: 131072,
            quantization: "fp16",
            supported_parameters: ["temperature", "max_tokens"],
          },
        ],
      },
    },
  });
  assert.equal(endpoints[0]?.upstreamProvider, "ExampleProvider");
  assert.equal(endpoints[0]?.limits.maxOutputTokens, 131072);
  assert.equal(endpoints[0]?.quantization, "fp16");
  assert.equal(endpoints[0]?.supportedParameters?.[0]?.state, "api_advertised");
});

test("requires a qualified matching registry record for live eligibility", () => {
  const { labModel, providerProfile } = profiles();
  const qualification = createModelQualificationRecord({
    modelProfileHash: labModel.profileHash,
    providerProfileHash: providerProfile.profileHash,
    protocol: "chat_completions",
    harnessVersion: "test",
    declaredEvidence: [],
    probes: [
      {
        probeId: "Q0",
        requestArtifactId: "q0",
        capabilityEvidence: [],
        status: "pass",
      },
    ],
  });
  const entry = createModelRegistry([
    {
      schemaVersion: 1,
      id: "example",
      labModel,
      providerProfile,
      qualifications: [qualification],
      liveEligibility: "eligible",
    },
  ])[0]!;
  assert.equal(isModelRegistryEntryEligible(entry), true);
  assert.equal(
    isModelRegistryEntryEligible(entry, { providerProfileHash: "stale" }),
    false,
  );
  assert.equal(
    isModelRegistryEntryEligible({
      ...entry,
      providerProfile: {
        ...entry.providerProfile,
        lifecycle: { status: "deprecated" },
      },
    }),
    false,
  );
});

test("keeps volatile provider operations separate from model identity", () => {
  const operational = createProviderOperationalProfile({
    provider: "openrouter",
    retrySemantics: {
      rateLimit: "retryable_after_delay",
      serverError: "retryable_after_delay",
      timeout: "retryable_after_delay",
      affordability: "retryable_after_account_change",
      auth: "retryable_after_account_change",
    },
    affordabilityEvidence: {
      status: "insufficient",
      observedAt: "2026-08-29T00:00:00.000Z",
      source: "provider_response",
    },
  });
  assert.equal(Object.isFrozen(operational), true);
  assert.equal(operational.affordabilityEvidence?.status, "insufficient");
});

test("OpenRouter runner consumes strict envelope policy on the intercepted wire", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: "z-ai/glm-5.3-flash",
        provider: "ExampleProvider",
        openrouter_metadata: {
          endpoints: {
            available: [
              {
                provider: "ExampleProvider",
                model: "z-ai/glm-5.3-flash",
                selected: true,
                endpoint: "example-endpoint",
              },
            ],
          },
          attempts: [
            {
              provider: "ExampleProvider",
              model: "z-ai/glm-5.3-flash",
              status: 200,
              endpoint: "example-endpoint",
            },
          ],
        },
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: "length" },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8192,
          total_tokens: 8202,
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const runner = new OpenRouterApiRunner(
      "z-ai/glm-5.3-flash",
      {},
      {
        env: { OPENROUTER_API_KEY: "synthetic-router-key" },
        executionEnvelope: strictEnvelope(),
      },
    );
    await runner.execute("respond", z.object({ ok: z.literal(true) }));
    assert.equal(body.model, "z-ai/glm-5.3-flash");
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.provider, {
      allow_fallbacks: false,
      require_parameters: true,
      order: ["ExampleProvider"],
    });
    assert.equal(
      runner.getLastInvocationMetadata()?.execution_envelope_hash?.length,
      64,
    );
    assert.equal(
      runner.getLastInvocationMetadata()?.normalized_finish_reason,
      "OUTPUT_BUDGET_EXHAUSTED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

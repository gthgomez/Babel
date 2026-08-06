/**
 * pipeline.integration.test.ts — Integration tests for pipeline routing with offline fixtures.
 *
 * Uses BABEL_PIPELINE_V9_OFFLINE=1 to test pipeline stage routing without real LLM calls.
 * The offline fixture system returns scripted responses based on the stage and scenario.
 *
 * Scenarios tested:
 *   - happy_path: orchestrator → SWE → QA PASS → executor COMPLETE
 *   - qa_reject_once: QA rejects, SWE revises, QA passes on retry
 *   - qa_reject_max: QA always rejects, pipeline halts after MAX_SWE_QA_LOOPS
 *   - evidence_loop: SWE emits EVIDENCE_REQUEST
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildPipelineV9OfflineFixtureResponse,
  resetOfflineQaCallCount,
  type RunOptions,
} from '../src/execute.js';
import type { PipelineStage } from '../src/execute.js';
import { EvidenceBundle } from '../src/evidence.js';
import {
  EPISODE_EVENTS_FILENAME,
  flushEpisodeEventLog,
  loadEpisodeEventLogForMode,
  parseEpisodeEventLogResult,
  validateEpisodeEventLog,
} from '../src/evidence/episodeStream.js';
import { _runBabelPipelineInternal, resumeManualBridge } from '../src/pipeline.js';
import { OrchestratorManifestSchema } from '../src/schemas/agentContracts.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function setEnv(key: string, value: string | undefined): () => void {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return () => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
}

function orchestratorPrompt(): string {
  return 'otel regression: Analyze the task below and output the orchestration manifest. autonomous lane. Include OLS-v9-Orchestrator.md in your analysis. "compilation_state": "uncompiled"';
}

function swePrompt(): string {
  return 'Analyze the task below and produce the SWE Plan. Regression backend verified lane.';
}

function qaPrompt(): string {
  return 'Review the SWE Plan below and produce a QA verdict. Regression backend verified lane.';
}

function executorPrompt(): string {
  return 'Execute the following plan. EXECUTION HISTORY is empty.';
}

function orchestratorOptions(): RunOptions {
  return { stage: 'orchestrator' as PipelineStage, schemaName: 'orchestrator' };
}
function planningOptions(): RunOptions {
  return { stage: 'planning' as PipelineStage, schemaName: 'swe_plan' };
}
function qaOptions(): RunOptions {
  return { stage: 'qa' as PipelineStage, schemaName: 'qa_verdict' };
}
function executorOptions(): RunOptions {
  return { stage: 'executor' as PipelineStage, schemaName: 'executor_turn' };
}

function buildOfflineIntegrationManifest(): unknown {
  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    target_project_path: process.cwd(),
    analysis: {
      task_summary: 'OTEL regression pipeline episode integration.',
      task_category: 'Backend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'deep',
      purpose_mode: 'execution',
      purpose_source: 'fallback_default',
      purpose_confidence: 0.7,
      ambiguity_note: null,
      routing_confidence: 0.95,
    },
    platform_profile: {
      profile_source: 'not_required_for_routing',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'none',
      repo_write_mode: null,
      output_surface: [],
      platform_modes: [],
      execution_trust: null,
      data_trust: null,
      freshness_trust: null,
      action_trust: null,
      approval_mode: 'none',
    },
    worker_configuration: { assigned_model: 'qwen3', rationale: 'Offline episode integration fixture.' },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v11'],
      domain_id: 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'BABEL_EPISODE_STREAM_INTEGRATION: implement the verified pipeline event stream.',
      system_directive: 'Resolve the instruction stack and execute the offline fixture.',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Offline fixture enabled/disabled
// ═══════════════════════════════════════════════════════════════════════════════

describe('offline fixture activation', () => {
  let restore: () => void;

  afterEach(() => {
    if (restore) restore();
  });

  it('returns null when BABEL_PIPELINE_V9_OFFLINE is not set', () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', undefined);
    const result = buildPipelineV9OfflineFixtureResponse(
      orchestratorPrompt(),
      orchestratorOptions(),
    );
    assert.equal(result, null);
  });

  it('returns fixture when BABEL_PIPELINE_V9_OFFLINE=1', () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    // Use the OTEL orchestrator path which is the only orchestrator fixture
    const result = buildPipelineV9OfflineFixtureResponse(
      'otel regression: Analyze the task below and output the orchestration manifest. autonomous lane.',
      { stage: 'orchestrator' as PipelineStage },
    );
    assert.ok(result !== null, 'Should return a fixture when offline mode is enabled');
    assert.ok(typeof result === 'object');
  });

  it('returns null when BABEL_PIPELINE_V9_OFFLINE is set to other value', () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '0');
    const result = buildPipelineV9OfflineFixtureResponse(
      orchestratorPrompt(),
      orchestratorOptions(),
    );
    assert.equal(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Happy path scenario (default)
// ═══════════════════════════════════════════════════════════════════════════════

describe('happy_path scenario', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    delete process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
    resetOfflineQaCallCount();
  });

  afterEach(() => {
    if (restore) restore();
  });

  it('orchestrator returns a manifest with required fields', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      orchestratorPrompt(),
      orchestratorOptions(),
    ) as Record<string, unknown> | null;
    assert.ok(result !== null);
    assert.equal(result.orchestrator_version, '9.0');
    assert.ok(typeof result.analysis === 'object');
    assert.ok(typeof result.instruction_stack === 'object');
    const stack = result.instruction_stack as Record<string, unknown> | undefined;
    assert.ok(stack !== undefined);
    assert.ok(Array.isArray(stack.behavioral_ids));
  });

  it('orchestrator manifest includes pipeline_mode', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      orchestratorPrompt(),
      orchestratorOptions(),
    ) as Record<string, unknown> | null;
    assert.ok(result !== null);
    const analysis = result.analysis as Record<string, unknown>;
    assert.ok(
      analysis.pipeline_mode === 'deep',
      `Expected pipeline_mode to be deep, got ${analysis.pipeline_mode}`,
    );
  });

  it('SWE returns an IMPLEMENTATION_PLAN', () => {
    const result = buildPipelineV9OfflineFixtureResponse(swePrompt(), planningOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.plan_type, 'IMPLEMENTATION_PLAN');
    assert.ok(Array.isArray(result.minimal_action_set));
    assert.ok((result.minimal_action_set as unknown[]).length > 0);
  });

  it('SWE plan has required fields', () => {
    const result = buildPipelineV9OfflineFixtureResponse(swePrompt(), planningOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.plan_version, '1.0');
    assert.ok(typeof result.task_summary === 'string');
    assert.ok(Array.isArray(result.known_facts));
    assert.ok(Array.isArray(result.risks));
    assert.ok(Array.isArray(result.out_of_scope));
  });

  it('QA returns PASS verdict', () => {
    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.verdict, 'PASS');
    assert.ok((result.overall_confidence as number) >= 1);
    assert.ok((result.overall_confidence as number) <= 5);
  });

  it('executor returns COMPLETE', () => {
    const result = buildPipelineV9OfflineFixtureResponse(
      executorPrompt(),
      executorOptions(),
    ) as Record<string, unknown> | null;
    assert.ok(result !== null);
    assert.equal(result.type, 'completion');
    assert.equal(result.status, 'EXECUTION_COMPLETE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. QA reject-once scenario
// ═══════════════════════════════════════════════════════════════════════════════

describe('qa_reject_once scenario', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'qa_reject_once';
    resetOfflineQaCallCount();
  });

  afterEach(() => {
    if (restore) restore();
  });

  it('first QA call returns REJECT verdict', () => {
    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.verdict, 'REJECT');
    assert.ok(Array.isArray(result.failures));
    assert.ok((result.failures as unknown[]).length > 0);
  });

  it('second QA call returns PASS verdict', () => {
    // First call (reject)
    buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions());
    // Second call (pass)
    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.verdict, 'PASS');
    assert.ok((result.overall_confidence as number) >= 3);
  });

  it('third QA call also returns PASS', () => {
    buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions());
    buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions());
    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.verdict, 'PASS');
  });

  it('REJECT includes failures with required fields', () => {
    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    const failures = result.failures as Array<Record<string, unknown>>;
    assert.ok(failures.length > 0);
    const failure = failures[0]!;
    assert.ok(typeof failure.tag === 'string');
    assert.ok(typeof failure.severity === 'string');
    assert.ok(typeof failure.description === 'string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. QA reject-max scenario
// ═══════════════════════════════════════════════════════════════════════════════

describe('qa_reject_max scenario', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'qa_reject_max';
    resetOfflineQaCallCount();
  });

  afterEach(() => {
    if (restore) restore();
  });

  it('all QA calls return REJECT', () => {
    for (let i = 0; i < 5; i++) {
      const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
        string,
        unknown
      > | null;
      assert.ok(result !== null);
      assert.equal(result.verdict, 'REJECT', `Call ${i + 1} should return REJECT`);
    }
  });

  it('QA rejections are consistent (same failure structure)', () => {
    const r1 = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    const r2 = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(r1 !== null && r2 !== null);
    assert.equal(r1.verdict, r2.verdict);
    assert.equal((r1.failures as unknown[]).length, (r2.failures as unknown[]).length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Evidence loop scenario
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence_loop scenario', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'evidence_loop';
    resetOfflineQaCallCount();
  });

  afterEach(() => {
    if (restore) restore();
  });

  it('SWE returns EVIDENCE_REQUEST plan type', () => {
    const result = buildPipelineV9OfflineFixtureResponse(swePrompt(), planningOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.plan_type, 'EVIDENCE_REQUEST');
  });

  it('EVIDENCE_REQUEST plan has minimal read-only actions', () => {
    const result = buildPipelineV9OfflineFixtureResponse(swePrompt(), planningOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    const actions = result.minimal_action_set as Array<Record<string, unknown>>;
    assert.ok(actions.length > 0);
    for (const action of actions) {
      assert.ok(
        action.tool === 'file_read' || action.tool === 'directory_list',
        `EVIDENCE_REQUEST actions should be read-only, got ${action.tool}`,
      );
      assert.equal(action.reversible, true);
    }
  });

  it('EVIDENCE_REQUEST plan task_summary mentions evidence', () => {
    const result = buildPipelineV9OfflineFixtureResponse(swePrompt(), planningOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    const summary = result.task_summary as string;
    assert.ok(
      summary.toLowerCase().includes('evidence') || summary.includes('EVIDENCE_REQUEST'),
      `Task summary should mention evidence: ${summary}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Scenario isolation: state reset between scenarios
// ═══════════════════════════════════════════════════════════════════════════════

describe('scenario state isolation', () => {
  let restore: () => void;

  afterEach(() => {
    if (restore) restore();
  });

  it('resetOfflineQaCallCount clears QA call count', () => {
    // Set up qa_reject_once, call QA twice
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'qa_reject_once';

    buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()); // REJECT
    buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()); // PASS

    // Reset and switch scenario
    resetOfflineQaCallCount();
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'happy_path';

    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    // Should be PASS from happy_path, not REJECT from stale qa_reject_once state
    assert.ok(result !== null);
    assert.equal(result.verdict, 'PASS');
  });

  it('switching from qa_reject_once to qa_reject_max works after reset', () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'qa_reject_once';
    buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions());

    resetOfflineQaCallCount();
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = 'qa_reject_max';

    const result = buildPipelineV9OfflineFixtureResponse(qaPrompt(), qaOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.verdict, 'REJECT', 'Should use qa_reject_max scenario after reset');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. OTEL regression fixtures (existing coverage preserved)
// ═══════════════════════════════════════════════════════════════════════════════

describe('OTEL regression fixture path', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    delete process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
  });

  afterEach(() => {
    if (restore) restore();
  });

  it('OTEL orchestrator prompt returns a manifest', () => {
    const prompt =
      'otel regression: Analyze the task below and output the orchestration manifest. autonomous lane.';
    const result = buildPipelineV9OfflineFixtureResponse(prompt, orchestratorOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.orchestrator_version, '9.0');
  });

  it('OTEL executor prompt returns file_read on first call', () => {
    const prompt = 'otel regression autonomous lane. EXECUTION HISTORY\n[Step 0] No prior steps.';
    const result = buildPipelineV9OfflineFixtureResponse(prompt, executorOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.type, 'tool_call');
    assert.equal(result.tool, 'file_read');
  });

  it('OTEL executor prompt returns COMPLETE after manifest read', () => {
    const prompt =
      'otel regression autonomous lane. EXECUTION HISTORY\n' +
      '[Step 1] file_read runs/latest/01_manifest.json\nExit code: 0\n{"orchestrator_version":"9.0"}';
    const result = buildPipelineV9OfflineFixtureResponse(prompt, executorOptions()) as Record<
      string,
      unknown
    > | null;
    assert.ok(result !== null);
    assert.equal(result.type, 'completion');
    assert.equal(result.status, 'EXECUTION_COMPLETE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Notes on full end-to-end pipeline integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('full pipeline integration', () => {
  it('runs the offline pipeline through finalization with one valid episode chain', async () => {
    const previousOffline = process.env['BABEL_PIPELINE_V9_OFFLINE'];
    const previousScenario = process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
    const previousEpisodeIntegration = process.env['BABEL_EPISODE_STREAM_INTEGRATION'];
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-pipeline-episode-integration-'));
    let memoryExtractorCalls = 0;
    try {
      process.env['BABEL_PIPELINE_V9_OFFLINE'] = '1';
      delete process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
      process.env['BABEL_EPISODE_STREAM_INTEGRATION'] = '1';
      resetOfflineQaCallCount();
      const task = 'BABEL_EPISODE_STREAM_INTEGRATION: implement the verified pipeline event stream.';
      const evidence = new EvidenceBundle(task, runsRoot);
      const result = await _runBabelPipelineInternal(
        task,
        {
          orchestratorVersion: 'v9',
          mode: 'deep',
          disableMemoryExtraction: true,
          memoryExtractor: async () => { memoryExtractorCalls++; },
        },
        evidence,
        OrchestratorManifestSchema.parse(buildOfflineIntegrationManifest()),
      );
      assert.equal(result.episodePersistenceStatus, 'active');
      assert.equal(memoryExtractorCalls, 0, 'offline integration must not invoke memory extraction');
      const episodePath = join(evidence.runDir, EPISODE_EVENTS_FILENAME);
      assert.equal(existsSync(episodePath), true);
      const parsed = parseEpisodeEventLogResult(readFileSync(episodePath, 'utf-8'));
      if (!parsed.ok) throw new Error('offline pipeline wrote an invalid episode stream');
      assert.equal(validateEpisodeEventLog(parsed.value.events, parsed.value.sessionId).valid, true);
      const events = parsed.value.events;
      assert.equal(events.filter((event) => event.type === 'PIPELINE_COMPLETION').length, 1);
      const completion = events.find((event) => event.type === 'PIPELINE_COMPLETION');
      assert.equal(completion?.payload['outcome'], result.status);
      assert.equal(events.at(-1)?.type, 'PIPELINE_COMPLETION');
      for (const phase of ['orchestrator', 'swe_planning', 'qa_review', 'executor', 'finalization']) {
        assert.ok(events.some((event) => event.type === 'PIPELINE_PHASE_STARTED' && event.payload['phase'] === phase), `missing started phase ${phase}`);
        assert.ok(events.some((event) => event.type === 'PIPELINE_PHASE_COMPLETED' && event.payload['phase'] === phase), `missing completed phase ${phase}`);
      }
      assert.ok(events.some((event) => event.kind === 'tool'), 'expected executor tool episode event');
    } finally {
      if (previousOffline === undefined) delete process.env['BABEL_PIPELINE_V9_OFFLINE'];
      else process.env['BABEL_PIPELINE_V9_OFFLINE'] = previousOffline;
      if (previousScenario === undefined) delete process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'];
      else process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO'] = previousScenario;
      if (previousEpisodeIntegration === undefined) delete process.env['BABEL_EPISODE_STREAM_INTEGRATION'];
      else process.env['BABEL_EPISODE_STREAM_INTEGRATION'] = previousEpisodeIntegration;
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('manual invalid-plan resume finalizes a legacy stream and an existing valid stream', async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-manual-episode-integration-'));
    try {
      const task = 'BABEL_EPISODE_STREAM_INTEGRATION: manual resume.';
      const legacyEvidence = new EvidenceBundle(task, runsRoot);
      legacyEvidence.writeManifest(OrchestratorManifestSchema.parse(buildOfflineIntegrationManifest()));
      const legacyResult = await resumeManualBridge(legacyEvidence.runDir, { rawPlanText: '{bad json' });
      assert.equal(legacyResult.status, 'MANUAL_PLAN_INVALID');
      const legacyEvents = parseEpisodeEventLogResult(readFileSync(join(legacyEvidence.runDir, EPISODE_EVENTS_FILENAME), 'utf-8'));
      if (!legacyEvents.ok) throw new Error('legacy manual resume did not write a valid episode stream');
      assert.equal(legacyEvents.value.events[0]!.type, 'LEGACY_MIGRATION_GENESIS');
      for (const phase of ['swe_planning', 'qa_review', 'executor']) {
        assert.equal(legacyEvents.value.events.some((event) => event.payload['phase'] === phase), false, `invalid manual plan fabricated ${phase}`);
      }

      const existingEvidence = new EvidenceBundle(task, runsRoot);
      existingEvidence.writeManifest(OrchestratorManifestSchema.parse(buildOfflineIntegrationManifest()));
      const created = loadEpisodeEventLogForMode(existingEvidence.runDir, { mode: 'new', sessionId: 'manual-existing' });
      if (!created.ok) throw new Error('failed to create existing manual episode stream');
      flushEpisodeEventLog(existingEvidence.runDir, created.value);
      const existingResult = await resumeManualBridge(existingEvidence.runDir, { rawPlanText: '{bad json' });
      assert.equal(existingResult.status, 'MANUAL_PLAN_INVALID');
      const existingEvents = parseEpisodeEventLogResult(readFileSync(join(existingEvidence.runDir, EPISODE_EVENTS_FILENAME), 'utf-8'), { sessionId: 'manual-existing' });
      if (!existingEvents.ok) throw new Error('existing manual resume broke the episode chain');
      assert.equal(existingEvents.value.events[0]!.type, 'PIPELINE_GENESIS');
      assert.equal(validateEpisodeEventLog(existingEvents.value.events, 'manual-existing').valid, true);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('preserves active or degraded episode status on recoverable early errors', async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-pipeline-episode-error-status-'));
    const previousRoot = process.env['BABEL_PROJECT_ROOT'];
    const missingRoot = join(runsRoot, 'missing-project');
    try {
      const manifest = OrchestratorManifestSchema.parse(buildOfflineIntegrationManifest());
      const activeEvidence = new EvidenceBundle('recoverable active status', runsRoot);
      activeEvidence.writeManifest(manifest);
      activeEvidence.writeDebugFile('04_execution_report.json', JSON.stringify({ status: 'partial' }));
      process.env['BABEL_PROJECT_ROOT'] = missingRoot;
      const active = await _runBabelPipelineInternal('recoverable active status', { mode: 'deep' }, activeEvidence, manifest);
      assert.equal(active.status, 'EXECUTOR_HALTED');
      assert.equal(active.episodePersistenceStatus, 'active');
      const activeEpisodes = parseEpisodeEventLogResult(
        readFileSync(join(activeEvidence.runDir, EPISODE_EVENTS_FILENAME), 'utf-8'),
      );
      if (!activeEpisodes.ok) throw new Error('recoverable pipeline wrote an invalid episode stream');
      const activeCompletions = activeEpisodes.value.events.filter(
        (event) => event.type === 'PIPELINE_COMPLETION',
      );
      assert.equal(activeCompletions.length, 1);
      assert.equal(activeCompletions[0]!.payload['outcome'], active.status);
      assert.equal(activeEpisodes.value.events.at(-1)?.type, 'PIPELINE_COMPLETION');

      const degradedEvidence = new EvidenceBundle('recoverable degraded status', runsRoot);
      degradedEvidence.writeManifest(manifest);
      degradedEvidence.writeDebugFile('04_execution_report.json', JSON.stringify({ status: 'partial' }));
      writeFileSync(join(degradedEvidence.runDir, EPISODE_EVENTS_FILENAME), 'existing stream\n', 'utf-8');
      const degraded = await _runBabelPipelineInternal('recoverable degraded status', { mode: 'deep' }, degradedEvidence, manifest);
      assert.equal(degraded.status, 'EXECUTOR_HALTED');
      assert.equal(degraded.episodePersistenceStatus, 'degraded');
    } finally {
      if (previousRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = previousRoot;
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

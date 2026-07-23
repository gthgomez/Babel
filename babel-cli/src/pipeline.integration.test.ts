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

import {
  buildPipelineV9OfflineFixtureResponse,
  resetOfflineQaCallCount,
  type RunOptions,
} from '../src/execute.js';
import type { PipelineStage } from '../src/execute.js';

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

describe('full pipeline integration (documented)', () => {
  it('TODO: end-to-end pipeline test with CLI stub', () => {
    // Full pipeline integration testing requires running the complete pipeline
    // with the CLI stub approach used by test_pipeline_v9.ts.
    //
    // The offline fixture system tested above validates that each stage returns
    // correct responses for each scenario. The next step is to wire these
    // fixtures into a complete pipeline run that exercises:
    //   1. Orchestrator → SWE → QA PASS → Executor (full happy path)
    //   2. Orchestrator → SWE → QA REJECT → SWE replan → QA PASS → Executor
    //   3. Orchestrator → SWE → QA REJECT × MAX_SWE_QA_LOOPS → halt
    //   4. Orchestrator → SWE (EVIDENCE_REQUEST) → evidence → SWE (IMPLEMENTATION_PLAN) → ...
    //
    // This is tracked as Phase A2 in the critique remediation roadmap.
    assert.ok(true, 'Documented coverage gap — full pipeline integration test planned');
  });
});

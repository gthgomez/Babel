import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enableInMemoryTelemetryForTests,
  getFinishedTestSpans,
  resetTelemetryForTests,
} from '../src/telemetry/tracing.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function writeStubFiles(root: string): {
  claudeCmd: string;
  codexCmd: string;
} {
  const fakeLlmPath = join(root, 'fake-llm.mjs');
  const fakeLlmSource = `
import { readFileSync } from 'node:fs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function detectMode(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('otel autonomous lane')) {
    return 'autonomous';
  }
  return 'verified';
}

function buildOrchestratorManifest(mode) {
  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: mode === 'autonomous'
        ? 'OTel regression autonomous lane.'
        : 'OTel regression verified lane.',
      task_category: 'Backend',
      secondary_category: null,
      complexity_estimate: 'Medium',
      pipeline_mode: mode,
      ambiguity_note: null,
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
    worker_configuration: {
      assigned_model: 'Codex',
      rationale: 'OTel regression fixture selects Codex.',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: ['pipeline_qa_reviewer'],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: mode === 'autonomous'
        ? 'OTEL autonomous lane TELEMETRY_SECRET_TASK_MARKER'
        : 'OTEL verified lane TELEMETRY_SECRET_TASK_MARKER',
      system_directive: 'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  };
}

function buildSwePlan() {
  return {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Exercise OTel tracing without leaking prompt contents.',
    known_facts: [
      'The orchestrator emitted a typed v9 manifest.',
      'The tracing test needs a valid QA PASS path.',
    ],
    assumptions: [
      'A single safe read-only step is sufficient for autonomous executor validation.',
    ],
    risks: [
      {
        risk: 'The executor completion could become schema-invalid without a verified step.',
        likelihood: 'low',
        mitigation: 'Emit one file_read step before EXECUTION_COMPLETE.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read the local package manifest for executor trace coverage.',
        tool: 'file_read',
        target: '/project/package.json',
        rationale: 'Provides one safe executor step before completion.',
        reversible: true,
        verification: 'Exit code is 0 and stdout is non-empty.',
      },
    ],
    root_cause: 'N/A — tracing regression coverage',
    out_of_scope: [
      'Repository mutation',
      'Shell execution',
    ],
  };
}

function buildQaPass() {
  return {
    verdict: 'PASS',
    overall_confidence: 5,
    notes: 'Tracing regression fixture plan is sufficient.',
  };
}

async function main() {
  const runnerKind = process.argv[2];
  let prompt = '';

  if (runnerKind === 'codex') {
    const promptPath = process.argv[process.argv.length - 1];
    if (!promptPath) {
      throw new Error('codex stub expected a prompt file path');
    }
    prompt = readFileSync(promptPath, 'utf-8');
  } else {
    prompt = await readStdin();
  }

  const mode = detectMode(prompt);
  let payload;

  if (prompt.includes('OLS-v9-Orchestrator.md') || prompt.includes('"compilation_state": "uncompiled"')) {
    payload = buildOrchestratorManifest(mode);
  } else if (prompt.includes('Analyze the task below and produce the SWE Plan')) {
    payload = buildSwePlan();
  } else if (prompt.includes('Review the SWE Plan below and produce a QA verdict')) {
    payload = buildQaPass();
  } else if (prompt.includes('Execute the following approved SWE Plan.')) {
    payload = prompt.includes('(No steps executed yet')
      ? { type: 'tool_call', tool: 'file_read', path: '/project/package.json' }
      : { type: 'completion', status: 'EXECUTION_COMPLETE' };
  } else {
    throw new Error('Unrecognized Babel stage prompt in fake telemetry runner.');
  }

  process.stdout.write(JSON.stringify(payload));
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
`.trimStart();

  writeFileSync(fakeLlmPath, fakeLlmSource, 'utf-8');

  const claudeCmd = join(root, 'claude.cmd');
  const codexCmd = join(root, 'codex.cmd');

  writeFileSync(
    claudeCmd,
    `@echo off\r\nnode "${fakeLlmPath}" claude\r\n`,
    'utf-8',
  );
  writeFileSync(
    codexCmd,
    [
      '@echo off',
      'set "last="',
      ':next',
      'if "%~1"=="" goto run',
      'set "last=%~1"',
      'shift',
      'goto next',
      ':run',
      `node "${fakeLlmPath}" codex "%last%"`,
      '',
    ].join('\r\n'),
    'utf-8',
  );

  return { claudeCmd, codexCmd };
}

function withPatchedEnv(
  envPatch: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envPatch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function assertTraceContext(runDir: string, expectedLaneId: string): void {
  const traceContextPath = join(runDir, '07_trace_context.json');
  const traceContext = JSON.parse(readFileSync(traceContextPath, 'utf-8')) as {
    enabled?: boolean;
    trace_id?: string;
    root_span_id?: string;
    baggage?: Record<string, string>;
  };

  assert(traceContext.enabled === true, `Expected tracing to be enabled for ${runDir}`);
  assert(typeof traceContext.trace_id === 'string' && traceContext.trace_id.length > 0, `Expected trace_id for ${runDir}`);
  assert(typeof traceContext.root_span_id === 'string' && traceContext.root_span_id.length > 0, `Expected root_span_id for ${runDir}`);
  assert(traceContext.baggage?.['babel.lane.id'] === expectedLaneId, `Expected baggage lane ${expectedLaneId}, got ${traceContext.baggage?.['babel.lane.id']}`);
  assert(traceContext.baggage?.['babel.evidence_gate.status'] === 'satisfied', `Expected satisfied evidence gate baggage for ${runDir}`);
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-otel-test-'));
  const runsDir = join(tempDir, 'runs');
  const { claudeCmd, codexCmd } = writeStubFiles(tempDir);

  try {
    await enableInMemoryTelemetryForTests();
    await withPatchedEnv(
      {
        BABEL_CLAUDE_CMD: claudeCmd,
        BABEL_CLAUDE_ARGS: '',
        BABEL_CODEX_CMD: codexCmd,
        BABEL_CODEX_ARGS: '',
        BABEL_RUNS_DIR: runsDir,
        BABEL_OTEL_ENABLED: 'true',
        BABEL_OTEL_SERVICE_NAME: 'babel-cli-tests',
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      async () => {
        const { runBabelPipeline } = await import('../src/pipeline.js');

        const spanStartIndex = getFinishedTestSpans().length;

        const verifiedResult = await runBabelPipeline(
          'OTEL verified lane TELEMETRY_SECRET_TASK_MARKER',
          {
            orchestratorVersion: 'v9',
            mode: 'verified',
          },
        );
        const autonomousResult = await runBabelPipeline(
          'OTEL autonomous lane TELEMETRY_SECRET_TASK_MARKER',
          {
            orchestratorVersion: 'v9',
            mode: 'autonomous',
          },
        );

        assert(verifiedResult.status === 'COMPLETE', `Expected verified run COMPLETE, got ${verifiedResult.status}`);
        assert(autonomousResult.status === 'COMPLETE', `Expected autonomous run COMPLETE, got ${autonomousResult.status}`);

        assertTraceContext(verifiedResult.runDir, '9.0:verified');
        assertTraceContext(autonomousResult.runDir, '9.0:autonomous');

        const spans = getFinishedTestSpans().slice(spanStartIndex);
        const spanNames = spans.map(span => span.name);

        assert(spanNames.filter(name => name === 'babel.run').length === 2, `Expected 2 babel.run spans, got ${spanNames.filter(name => name === 'babel.run').length}`);
        assert(spanNames.filter(name => name === 'babel.orchestrator').length === 2, `Expected 2 babel.orchestrator spans, got ${spanNames.filter(name => name === 'babel.orchestrator').length}`);
        assert(spanNames.filter(name => name === 'babel.compiler').length === 2, `Expected 2 babel.compiler spans, got ${spanNames.filter(name => name === 'babel.compiler').length}`);
        assert(spanNames.filter(name => name === 'babel.qa').length === 2, `Expected 2 babel.qa spans, got ${spanNames.filter(name => name === 'babel.qa').length}`);
        assert(spanNames.filter(name => name === 'babel.executor.activation').length === 1, `Expected exactly 1 babel.executor.activation span, got ${spanNames.filter(name => name === 'babel.executor.activation').length}`);

        const serializedAttributes = JSON.stringify(
          spans.map(span => ({
            name: span.name,
            attributes: span.attributes,
          })),
        );

        for (const forbiddenFragment of [
          'TELEMETRY_SECRET_TASK_MARKER',
          'Analyze the task below',
          '--- START OF FILE:',
          '/project/package.json',
          'shell_exec',
        ]) {
          assert(
            !serializedAttributes.includes(forbiddenFragment),
            `Expected telemetry attributes to exclude "${forbiddenFragment}"`,
          );
        }
      },
    );

    // ── Disabled-path: no spans emitted, 07_trace_context.json written with enabled: false ──
    // resetTelemetryForTests clears the in-memory exporter entirely (returns [] after reset),
    // so the baseline for the disabled run is always 0 post-reset.
    await resetTelemetryForTests();
    const spanBaselineAfterReset = getFinishedTestSpans().length; // expect 0

    const disabledResult = await withPatchedEnv(
      {
        BABEL_CLAUDE_CMD: claudeCmd,
        BABEL_CLAUDE_ARGS: '',
        BABEL_CODEX_CMD: codexCmd,
        BABEL_CODEX_ARGS: '',
        BABEL_RUNS_DIR: runsDir,
        BABEL_OTEL_ENABLED: undefined,
        BABEL_OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        BABEL_OTEL_SERVICE_NAME: undefined,
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      async () => {
        const { runBabelPipeline } = await import('../src/pipeline.js');
        return runBabelPipeline('OTEL verified lane TELEMETRY_SECRET_TASK_MARKER', {
          orchestratorVersion: 'v9',
          mode: 'verified',
        });
      },
    );

    assert(disabledResult.status === 'COMPLETE', `Expected disabled run COMPLETE, got ${disabledResult.status}`);

    // No new spans should have been recorded
    const spanCountAfterDisabled = getFinishedTestSpans().length;
    assert(
      spanCountAfterDisabled === spanBaselineAfterReset,
      `Expected no new spans when telemetry disabled, got ${spanCountAfterDisabled - spanBaselineAfterReset} new span(s)`,
    );

    // 07_trace_context.json must exist with enabled: false and no trace_id
    const disabledTraceContextPath = join(disabledResult.runDir, '07_trace_context.json');
    const disabledTraceContext = JSON.parse(readFileSync(disabledTraceContextPath, 'utf-8')) as {
      enabled?: boolean;
      trace_id?: string;
    };
    assert(
      disabledTraceContext.enabled === false,
      `Expected enabled: false in disabled trace context, got ${disabledTraceContext.enabled}`,
    );
    assert(
      disabledTraceContext.trace_id === undefined,
      `Expected no trace_id in disabled trace context, got ${disabledTraceContext.trace_id}`,
    );

    console.log('otel tracing regression tests passed');
  } finally {
    await resetTelemetryForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isSyntheticProviderFixtureReady,
  prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture,
  summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs';

if (!isSyntheticProviderFixtureReady()) {
  test('Deep planning and review retain their ordered, bounded workflow in an isolated provider fixture', async (t) => {
    const fixture = prepareSyntheticProviderFixture();
    t.after(() => removeSyntheticProviderFixture(fixture.root));
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url)
          .href,
        '--import',
        import.meta.resolve('tsx'),
        '--test',
        '--test-reporter=tap',
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: fixture.cwd,
        env: fixture.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const code = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(1));
      child.once('close', (value) => resolve(value ?? 1));
    });
    t.diagnostic(summarizeSyntheticProviderOutput(output, code));
    for (const line of output
      .split('\n')
      .filter((line) => /^not ok \d+ - |^# DEEP_PLANNING_FIXTURE /.test(line)))
      t.diagnostic(line);
    assert.equal(
      code,
      0,
      'Deep must retain review, original scope and bounded recovery',
    );
  });
} else {
  process.env['BABEL_LIVE'] = 'true';
  process.env['BABEL_DRY_RUN'] = 'false';
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  process.env['BABEL_DESKTOP_PROVIDER'] = 'openrouter';
  process.env['BABEL_DESKTOP_MODEL_ROUTE'] = 'glm-5.3-flash';
  const { EvidenceBundle } = await import('../evidence.js');
  const { OrchestratorManifestSchema, SwePlanSchema } =
    await import('../schemas/agentContracts.js');
  const { _runBabelPipelineInternal } = await import('../pipeline.js');
  const { withPipelineModelRoute } = await import('../execute.js');
  const { globalCostTracker } = await import('../services/costTracker.js');
  const task =
    'Inspect existing.txt and explain its contents. Do not modify any files or run mutating commands.';
  const plan = SwePlanSchema.parse({
    plan_version: '1.0',
    plan_type: 'EVIDENCE_REQUEST',
    task_summary: task,
    assumptions: [],
    risks: [],
    out_of_scope: [],
    root_cause: 'Read-only inspection',
    minimal_action_set: [
      {
        step: 1,
        tool: 'file_read',
        target: 'existing.txt',
        description: 'Read the owner-requested file',
        rationale: 'Inspect actual evidence',
        reversible: true,
        verification: 'Observe its contents',
      },
    ],
  });
  const manifest = () =>
    OrchestratorManifestSchema.parse({
      orchestrator_version: '9.0',
      target_project: 'global',
      target_project_path: process.cwd(),
      analysis: {
        task_summary: task,
        task_category: 'Backend',
        secondary_category: null,
        task_overlay_ids: [],
        complexity_estimate: 'Low',
        pipeline_mode: 'deep',
        purpose_mode: 'execution',
        purpose_source: 'fallback_default',
        purpose_confidence: 0.9,
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
      worker_configuration: {
        assigned_model: 'deepseek-v4-pro',
        rationale:
          'Legacy schema family; effective route is pinned and asserted separately',
      },
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
        user_request: task,
        system_directive: 'Controlled Deep stage-order fixture',
      },
    });
  for (const kind of ['evidence', 'qa-reject', 'wrong-plan-type'] as const)
    test(`Deep planning contract: ${kind}`, async (t) => {
      const rejected = kind === 'qa-reject';
      writeFileSync('existing.txt', 'preserved owner source');
      globalCostTracker.resetSession();
      const reject = {
        verdict: 'REJECT',
        failure_count: 1,
        overall_confidence: 5,
        failures: [
          {
            tag: 'EVIDENCE-GATE',
            condition:
              'Controlled reviewer requires another inspection before execution.',
            confidence: 5,
          },
        ],
        proposed_fix_strategy: 'Inspect the requested evidence.',
      };
      const pass = { verdict: 'PASS', overall_confidence: 5 };
      const turns =
        kind === 'wrong-plan-type'
          ? [{ ...plan, plan_type: 'IMPLEMENTATION_PLAN' }, pass]
          : rejected
            ? [plan, reject, plan, reject, plan, reject]
            : [
                plan,
                pass,
                {
                  type: 'tool_call',
                  thinking: 'Read the authorized file',
                  tool: 'file_read',
                  path: 'existing.txt',
                },
              ];
      let calls = 0;
      t.mock.method(
        globalThis,
        'fetch',
        async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          assert.equal(
            String(url),
            'https://openrouter.ai/api/v1/chat/completions',
          );
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, 'z-ai/glm-5.3-flash');
          const turn = turns[calls++];
          assert.notEqual(
            turn,
            undefined,
            'no hidden model stages or unbounded retry',
          );
          return new Response(
            'data: ' +
              JSON.stringify({
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: JSON.stringify(turn) },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 10,
                  total_tokens: 20,
                },
              }) +
              '\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      );
      const evidence = new EvidenceBundle(task, process.env['BABEL_RUNS_DIR']!);
      const result = await withPipelineModelRoute('glm-5.3-flash', () =>
        _runBabelPipelineInternal(
          task,
          {
            mode: 'deep',
            modelOverride: 'glm-5.3-flash',
            disableMemoryExtraction: true,
            writeLatestPointers: false,
          },
          evidence,
          manifest(),
        ),
      );
      t.diagnostic(
        'DEEP_PLANNING_FIXTURE ' +
          JSON.stringify({ kind, status: result.status, calls }),
      );
      assert.equal(
        readFileSync('existing.txt', 'utf8'),
        'preserved owner source',
      );
      assert.equal(calls, turns.length);
      if (rejected) assert.equal(result.status, 'QA_REJECTED_MAX_LOOPS');
      else if (kind === 'wrong-plan-type')
        assert.equal(result.status, 'EXECUTOR_HALTED');
      else {
        assert.equal(result.status, 'READ_ONLY_NO_MODIFICATION');
        assert.match(result.finalAnswer ?? '', /existing\.txt/);
      }
    });
}

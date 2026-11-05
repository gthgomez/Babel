import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
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
  for (const kind of [
    'evidence',
    'answer-unavailable',
    'cancel-before-answer',
    'cancel-during-answer',
    'qa-reject',
    'wrong-plan-type',
    'evidence-godot',
    'premature-completion',
  ] as const)
    test(`Deep planning contract: ${kind}`, async (t) => {
      const rejected = kind === 'qa-reject';
      writeFileSync('existing.txt', 'preserved owner source');
      globalCostTracker.resetSession();
      const controller = new AbortController();
      const cancelled = kind === 'cancel-before-answer' || kind === 'cancel-during-answer';
      const godot = kind === 'evidence-godot' || kind === 'premature-completion';
      const ownerTask = godot ? `${task} Do not run any commands.` : task;
      let hostVerifications = 0;
      if (godot) {
        const wrapper = join(process.cwd(), 'synthetic-godot.ps1');
        writeFileSync(wrapper, '# Controlled wrapper marker; never executed.');
        writeFileSync('project.godot', '[application]\nconfig/name="Read-only fixture"\n');
        process.env['BABEL_GODOT_COMMAND'] = wrapper;
        process.env['BABEL_GODOT_POWERSHELL'] = 'synthetic-godot';
        const spawnSync = childProcess.spawnSync;
        t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof spawnSync>) => {
          if (args[0] === 'synthetic-godot') {
            hostVerifications++;
            return {pid:0,output:['','',''],stdout:'',stderr:'',status:0,signal:null};
          }
          return spawnSync(...args);
        });
        syncBuiltinESMExports();
        t.after(() => {
          t.mock.restoreAll();syncBuiltinESMExports();
          delete process.env['BABEL_GODOT_COMMAND'];delete process.env['BABEL_GODOT_POWERSHELL'];
          rmSync('project.godot', {force:true});rmSync(wrapper, {force:true});
        });
      }
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
          : kind === 'premature-completion'
            ? [plan, pass, {type:'completion',status:'EXECUTION_COMPLETE'}]
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
                {
                  answer:
                    'existing.txt contains "preserved owner source". No source files were modified.',
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
          if (!rejected && kind !== 'wrong-plan-type' && calls >= 4) {
            assert.match(String(init?.body), /preserved owner source/);
            assert.match(String(init?.body), /ORIGINAL OWNER REQUEST/);
            assert.match(String(init?.body), /untrusted evidence/);
            if (kind === 'cancel-during-answer') {
              controller.abort();
              assert.equal(init?.signal?.aborted, true, 'answer request must receive cancellation');
              throw controller.signal.reason;
            }
            if (kind === 'answer-unavailable')
              return new Response(
                JSON.stringify({
                  error: {
                    message: 'Controlled unavailable answer',
                    code: 401,
                  },
                }),
                { status: 401 },
              );
          }
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
      const evidence = new EvidenceBundle(ownerTask, process.env['BABEL_RUNS_DIR']!);
      if (kind === 'cancel-before-answer') {
        const writeContext = evidence.writeCompiledContext.bind(evidence);
        t.mock.method(evidence, 'writeCompiledContext', (stage: string, context: string) => {
          writeContext(stage, context);
          if (stage === 'evidence_answer') controller.abort();
        });
      }
      const result = await withPipelineModelRoute('glm-5.3-flash', () =>
        _runBabelPipelineInternal(
          ownerTask,
          {
            mode: 'deep',
            modelOverride: 'glm-5.3-flash',
            disableMemoryExtraction: true,
            writeLatestPointers: false,
            abortSignal: controller.signal,
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
      if (godot) {
        t.diagnostic(`DEEP_PLANNING_FIXTURE ${JSON.stringify({kind,modelCalls:calls,hostVerifications})}`);
        assert.equal(hostVerifications,0,'read-only completion must not execute runtime verification or artifact repair');
      }
      if (kind === 'answer-unavailable') assert.ok(calls >= 4);
      else assert.equal(calls, kind === 'cancel-before-answer' ? 3 : turns.length);
      if (rejected) assert.equal(result.status, 'QA_REJECTED_MAX_LOOPS');
      else if (kind === 'wrong-plan-type')
        assert.equal(result.status, 'EXECUTOR_HALTED');
      else if (kind === 'premature-completion') {
        assert.equal(result.status, 'EXECUTOR_HALTED');
        const report = JSON.parse(readFileSync(join(evidence.runDir,'04_execution_report.json'),'utf8'));
        assert.equal(report.pipeline_error.halt_tag,'STEP_VERIFICATION_FAIL');
        assert.match(report.pipeline_error.condition, /EVIDENCE_REQUEST/);
        assert.equal(existsSync(join(evidence.runDir,'10_runtime_verification.json')),false);
      }
      else if (cancelled) {
        assert.equal(result.status, 'EXECUTOR_HALTED');
        const {buildRunResultPayload} = await import('../cli/structuredOutput.js');
        const payload = buildRunResultPayload(result, {task, mode:'deep'});
        assert.equal(payload['terminal_outcome'], 'CANCELLED');
        assert.doesNotMatch(result.finalAnswer ?? '', /preserved owner source/);
      } else if (kind === 'answer-unavailable') {
        assert.equal(result.status, 'EXECUTOR_HALTED');
        assert.match(
          result.errors?.join(' ') ?? '',
          /could not produce the requested answer/,
        );
        assert.doesNotMatch(
          result.finalAnswer ?? '',
          /Evidence gathered and finalized/,
        );
      } else {
        assert.equal(result.status, 'READ_ONLY_NO_MODIFICATION');
        assert.match(result.finalAnswer ?? '', /existing\.txt/);
        assert.match(result.finalAnswer ?? '', /preserved owner source/);
      }
    });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runPlanLane } from './planLane.js';
import { stripAnsi } from '../../ui/theme.js';

const hasDeepSeekKey = !!process.env['DEEPSEEK_API_KEY'];

describe('runPlanLane', () => {
  it('uses DeepSeek Pro planning and writes artifacts without mutating repo source files', { skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-plan-lane-'));
    const source = join(repo, 'sample.txt');
    const originalFetch = globalThis.fetch;
    const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
    const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];
    writeFileSync(source, 'before\n', 'utf-8');
    const beforeHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    let requestedModel = '';
    try {
      delete process.env['DEEPSEEK_API_KEY'];
      process.env['DEEPINFRA_API_KEY'] = 'test-key';
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
        requestedModel = body.model ?? '';
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schema_version: 1,
                    status: 'PLAN_READY',
                    summary: 'Prepared a safe refactor plan.',
                    answer:
                      'Review sample.txt, make the smallest refactor, and verify with npm test.',
                    steps: [
                      'Inspect sample.txt',
                      'Apply the smallest safe refactor',
                      'Run npm test',
                    ],
                    likely_files: ['sample.txt'],
                    risks: ['Keep the refactor scoped.'],
                    verification: ['npm test'],
                    next: ['Run bl fix "Apply the safe refactor" when ready.'],
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await runPlanLane({
        task: 'Plan a safe refactor',
        projectRoot: repo,
        model: 'deepseek-v4-flash',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'PLAN_READY');
      assert.equal(result.payload.changed_files.length, 0);
      assert.ok(requestedModel.length > 0, `Expected a model to be requested, got empty`);
      const humanText = stripAnsi(result.humanText);
      assert.match(humanText, /^Babel Plan only Ready/);
      assert.match(humanText, /\nMode:\nPlan only/);
      assert.match(humanText, /Evidence:\n- Run:/);
      const afterHash = createHash('sha256').update(readFileSync(source)).digest('hex');
      assert.equal(afterHash, beforeHash);
      assert.ok(result.payload.run_dir?.replace(/\\/g, '/').includes('runs/babel-lite'));
      assert.equal(existsSync(join(result.payload.run_dir ?? '', 'model_plan.json')), true);
      assert.equal(existsSync(join(result.payload.run_dir ?? '', 'cost_ledger.json')), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDeepSeekKey === undefined) {
        delete process.env['DEEPSEEK_API_KEY'];
      } else {
        process.env['DEEPSEEK_API_KEY'] = originalDeepSeekKey;
      }
      if (originalDeepInfraKey === undefined) {
        delete process.env['DEEPINFRA_API_KEY'];
      } else {
        process.env['DEEPINFRA_API_KEY'] = originalDeepInfraKey;
      }
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('records runtime tool_call_log on mock provider discovery loop', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-plan-lane-mock-loop-'));
    writeFileSync(join(repo, 'README.md'), '# Sample\nTiny repo.\n', 'utf-8');
    writeFileSync(join(repo, 'sample.txt'), 'before\n', 'utf-8');
    const previousOffline = process.env['BABEL_LITE_OFFLINE'];
    process.env['BABEL_LITE_OFFLINE'] = '1';
    try {
      const result = await runPlanLane({
        task: 'Plan a safe refactor',
        projectRoot: repo,
        provider: 'mock',
      });
      assert.equal(result.exitCode, 0);
      assert.ok(result.payload.session_loop_steps && result.payload.session_loop_steps.length >= 4);
      const executionReport = JSON.parse(
        readFileSync(join(result.payload.run_dir ?? '', '04_execution_report.json'), 'utf-8'),
      ) as {
        tool_call_log?: unknown[];
        steps_executed?: number;
      };
      assert.ok(Array.isArray(executionReport.tool_call_log));
      assert.ok((executionReport.tool_call_log?.length ?? 0) >= 1);
      assert.ok((executionReport.steps_executed ?? 0) >= 1);
    } finally {
      if (previousOffline === undefined) {
        delete process.env['BABEL_LITE_OFFLINE'];
      } else {
        process.env['BABEL_LITE_OFFLINE'] = previousOffline;
      }
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('normalizes NEED_MORE_CONTEXT typo and empty summary from live providers', { skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-plan-lane-typo-'));
    writeFileSync(join(repo, 'README.md'), '# Sample\nA tiny repo.\n', 'utf-8');
    const originalFetch = globalThis.fetch;
    const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
    const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];
    try {
      delete process.env['DEEPSEEK_API_KEY'];
      process.env['DEEPINFRA_API_KEY'] = 'test-key';
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schema_version: 1,
                    status: 'NEED_MORE_CONTEXT',
                    summary: '',
                    answer: 'I cannot plan without more context about roadmap priorities.',
                    steps: [],
                    likely_files: [],
                    risks: [],
                    verification: [],
                    next: ['Clarify roadmap priorities'],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200 },
        )) as typeof fetch;

      const result = await runPlanLane({
        task: 'help me plan next features',
        projectRoot: repo,
        model: 'deepseek-v4-flash',
      });
      assert.equal(result.payload.status, 'NEEDS_MORE_CONTEXT');
      assert.equal(result.exitCode, 1);
      assert.doesNotMatch(result.humanText, /Zod validation failed/);
      assert.equal(
        existsSync(join(result.payload.run_dir ?? '', 'lite_schema_normalization.json')),
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDeepSeekKey === undefined) {
        delete process.env['DEEPSEEK_API_KEY'];
      } else {
        process.env['DEEPSEEK_API_KEY'] = originalDeepSeekKey;
      }
      if (originalDeepInfraKey === undefined) {
        delete process.env['DEEPINFRA_API_KEY'];
      } else {
        process.env['DEEPINFRA_API_KEY'] = originalDeepInfraKey;
      }
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('normalizes object-shaped plan arrays from live providers', { skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-plan-lane-objects-'));
    const source = join(repo, 'sample.txt');
    const originalFetch = globalThis.fetch;
    const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
    const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];
    writeFileSync(source, 'before\n', 'utf-8');
    try {
      delete process.env['DEEPSEEK_API_KEY'];
      process.env['DEEPINFRA_API_KEY'] = 'test-key';
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schema_version: 1,
                    status: 'PLAN_READY',
                    summary: 'Prepared a reliability comparison plan.',
                    answer: 'Compare the reliability paths and report findings.',
                    steps: [
                      { description: 'Inspect target consistency handling.' },
                      { action: 'Review latest pointer behavior.' },
                    ],
                    likely_files: [
                      { path: 'src/pipeline/targetConsistency.ts' },
                      { file: 'src/pipeline/runPointers.ts' },
                    ],
                    risks: [{ summary: 'Regression artifacts may be stale.' }],
                    verification: [{ command: 'npm test' }],
                    next: [{ description: 'Produce a findings report.' }],
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
          { status: 200 },
        )) as typeof fetch;

      const result = await runPlanLane({
        task: 'Compare reliability implementation paths',
        projectRoot: repo,
        model: 'deepseek-v4-flash',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'PLAN_READY');
      assert.doesNotMatch(result.humanText, /Zod validation failed|deepSeekApi|runner\(s\)/);
      assert.match(
        readFileSync(join(result.payload.run_dir ?? '', 'plan.md'), 'utf-8'),
        /Inspect target consistency handling\./,
      );

      const modelPlan = JSON.parse(
        readFileSync(join(result.payload.run_dir ?? '', 'model_plan.json'), 'utf-8'),
      ) as {
        steps: string[];
        likely_files: string[];
        risks: string[];
        verification: string[];
        next: string[];
      };
      assert.deepEqual(modelPlan.steps, [
        'Inspect target consistency handling.',
        'Review latest pointer behavior.',
      ]);
      assert.deepEqual(modelPlan.likely_files, [
        'src/pipeline/targetConsistency.ts',
        'src/pipeline/runPointers.ts',
      ]);
      assert.deepEqual(modelPlan.risks, ['Regression artifacts may be stale.']);
      assert.deepEqual(modelPlan.verification, ['npm test']);
      assert.deepEqual(modelPlan.next, ['Produce a findings report.']);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDeepSeekKey === undefined) {
        delete process.env['DEEPSEEK_API_KEY'];
      } else {
        process.env['DEEPSEEK_API_KEY'] = originalDeepSeekKey;
      }
      if (originalDeepInfraKey === undefined) {
        delete process.env['DEEPINFRA_API_KEY'];
      } else {
        process.env['DEEPINFRA_API_KEY'] = originalDeepInfraKey;
      }
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

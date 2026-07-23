import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AgentSession } from './session.js';
import { stripAnsi } from '../ui/theme.js';

const hasDeepSeekKey = !!process.env['DEEPSEEK_API_KEY'];
const originalFetch = globalThis.fetch;
const originalDeepSeekApiKey = process.env['DEEPSEEK_API_KEY'];
const originalDeepInfraApiKey = process.env['DEEPINFRA_API_KEY'];

function mockDeepSeekAskResponse(): void {
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
                status: 'ANSWER_READY',
                summary: 'The project is a local workspace.',
                answer:
                  'The evidence shows this is a local project with a README and package manifest.',
                facts: ['README.md is present.'],
                assumptions: [],
                evidence: [{ source: 'README.md', summary: 'Project title found in README.' }],
                next: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    )) as typeof fetch;
}

function mockDeepSeekPlanResponse(): void {
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
                summary: 'Prepared a read-only plan.',
                answer:
                  'Inspect the relevant files, choose the smallest change, and verify with the project test command.',
                steps: [
                  'Read the target files',
                  'Choose the smallest safe change',
                  'Run the verifier',
                ],
                likely_files: ['README.md'],
                risks: [],
                verification: ['npm test'],
                next: ['Review plan.md in the artifact directory.'],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    )) as typeof fetch;
}

function mockDeepSeekReportResponse(): void {
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
                status: 'REPORT_READY',
                summary: 'Compared the implementation paths.',
                answer:
                  'The evidence shows target consistency, latest pointers, and output review are distinct reliability layers.',
                findings: [
                  'Target consistency catches path drift.',
                  'Output review catches contradictory summaries.',
                ],
                inspected: ['README.md'],
                limitations: [],
                verification: [],
                next: ['Use babel plan for follow-up implementation.'],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    )) as typeof fetch;
}

function restoreDeepSeekMock(): void {
  globalThis.fetch = originalFetch;
  if (originalDeepSeekApiKey === undefined) {
    delete process.env['DEEPSEEK_API_KEY'];
  } else {
    process.env['DEEPSEEK_API_KEY'] = originalDeepSeekApiKey;
  }
  if (originalDeepInfraApiKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalDeepInfraApiKey;
  }
}

describe('AgentSession', () => {
  it('runs plan lane without manual bridge status', { concurrency: false, skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-session-plan-'));
    try {
      mockDeepSeekPlanResponse();
      const session = new AgentSession({
        task: 'Plan test coverage',
        verb: 'plan',
        projectRoot: repo,
      });
      const result = await session.run();
      assert.equal(result.exitCode, 0);
      assert.notEqual((result.payload as { status?: string }).status, 'MANUAL_BRIDGE_REQUIRED');
    } finally {
      restoreDeepSeekMock();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('runs ask lane via fast path', { concurrency: false, skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-session-ask-loop-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(repo, 'README.md'), '# Demo\n\nLocal demo project.\n', 'utf-8');
      mockDeepSeekAskResponse();
      const session = new AgentSession({
        task: 'what is this project?',
        verb: 'ask',
        projectRoot: repo,
      });
      const result = await session.run();
      assert.equal(result.exitCode, 0);
      const payload = result.payload as {
        status?: string;
        command?: string;
        answer?: { summary?: string };
      };
      assert.equal(payload.status, 'ANSWER_READY');
      assert.equal(payload.command, 'ask');
      assert.ok(payload.answer?.summary);
    } finally {
      restoreDeepSeekMock();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('runs plan lane with session loop steps', { concurrency: false }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-session-plan-loop-'));
    try {
      mockDeepSeekPlanResponse();
      const session = new AgentSession({
        task: 'Plan test coverage',
        verb: 'plan',
        projectRoot: repo,
        provider: 'mock',
      });
      const result = await session.run();
      assert.equal(result.exitCode, 0);
      const payload = result.payload as {
        status?: string;
        execution_path?: string;
        session_loop_steps?: Array<{ phase: string }>;
      };
      assert.equal(payload.status, 'PLAN_READY');
      assert.equal(payload.execution_path, 'session_loop');
      assert.ok((payload.session_loop_steps?.length ?? 0) >= 2);
    } finally {
      restoreDeepSeekMock();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it(
    'runs worker chain with mock provider on trust demo fixture',
    { concurrency: false },
    async () => {
      const { readLiteTrustDemoFixture, resolveLiteTrustDemoFixturePath } =
        await import('../services/liteTrustDemo.js');
      const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
      const repo = mkdtempSync(join(tmpdir(), 'babel-session-worker-'));
      try {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(
          join(repo, 'package.json'),
          JSON.stringify(
            {
              type: 'module',
              scripts: { test: 'node src/math.test.js' },
            },
            null,
            2,
          ),
          'utf-8',
        );
        writeFileSync(join(repo, fixture.target_file), fixture.broken_implementation, 'utf-8');
        writeFileSync(
          join(repo, 'src', 'math.test.js'),
          [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { add } from './math.js';",
            '',
            "test('add sums two numbers', () => {",
            '  assert.equal(add(1, 2), 3);',
            '});',
            '',
          ].join('\n'),
          'utf-8',
        );
        const gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: 'babel-lite',
          GIT_AUTHOR_EMAIL: 'babel-lite@local',
          GIT_COMMITTER_NAME: 'babel-lite',
          GIT_COMMITTER_EMAIL: 'babel-lite@local',
        };
        assert.equal(spawnSync('git', ['init'], { cwd: repo, encoding: 'utf-8' }).status, 0);
        assert.equal(
          spawnSync('git', ['add', '.'], { cwd: repo, encoding: 'utf-8', env: gitEnv }).status,
          0,
        );
        assert.equal(
          spawnSync('git', ['commit', '-m', 'init'], { cwd: repo, encoding: 'utf-8', env: gitEnv })
            .status,
          0,
        );

        const session = new AgentSession({
          task: fixture.task,
          verb: 'do',
          projectRoot: repo,
          provider: 'mock',
          workerChain: true,
        });
        const result = await session.run();
        assert.equal(result.exitCode, 0);
        assert.equal((result.payload as { status?: string }).status, 'WORKER_LOOP_COMPLETE');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it(
    'runs complex bl do with read-only Spark parallel review then plan lane',
    { concurrency: false, skip: !hasDeepSeekKey },
    async () => {
      const repo = mkdtempSync(join(tmpdir(), 'babel-session-spark-do-'));
      try {
        mockDeepSeekPlanResponse();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(repo, 'README.md'), '# Auth\n', 'utf-8');
        writeFileSync(
          join(repo, 'package.json'),
          '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
          'utf-8',
        );

        const session = new AgentSession({
          task: 'Plan a repo-wide migration for the authentication module without editing files',
          verb: 'do',
          projectRoot: repo,
          agentsMode: 'read-only',
        });
        const result = await session.run();
        assert.equal(result.exitCode, 0);
        const payload = result.payload as {
          status?: string;
          execution_path?: string;
          spark_agents?: Array<{ mode: string }>;
          spark_synthesis?: { mutation_allowed: boolean };
        };
        assert.equal(payload.status, 'PLAN_READY');
        assert.equal(payload.execution_path, 'spark_parallel_review_do');
        assert.equal(payload.spark_agents?.length, 4);
        assert.equal(
          payload.spark_agents?.every((agent) => agent.mode === 'read_only'),
          true,
        );
        assert.equal(payload.spark_synthesis?.mutation_allowed, false);
      } finally {
        restoreDeepSeekMock();
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('routes read-only comparison do tasks to report lane', { concurrency: false, skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-session-report-do-'));
    try {
      mockDeepSeekReportResponse();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(repo, 'README.md'), '# Reliability\n', 'utf-8');

      const session = new AgentSession({
        task: 'compare implementation paths for target drift and output review reliability',
        verb: 'do',
        projectRoot: repo,
      });
      const result = await session.run();
      assert.equal(result.exitCode, 0);
      const payload = result.payload as {
        status?: string;
        command?: string;
        selected_lane?: string;
        execution_path?: string;
      };
      assert.equal(payload.status, 'REPORT_READY');
      assert.equal(payload.command, 'do');
      assert.equal(payload.selected_lane, 'report');
      assert.equal(payload.execution_path, 'routed_do');
      const humanText = stripAnsi(result.humanText ?? '');
      assert.match(humanText, /^Babel Read-only report Ready/);
      assert.match(humanText, /\nMode:\nRead-only report/);
      assert.doesNotMatch(humanText, /\nRoute:/);
      assert.doesNotMatch(humanText, /\nComplexity:/);
      assert.doesNotMatch(humanText, /\nFull equivalent:/);
    } finally {
      restoreDeepSeekMock();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it(
    'runs fix lane with session loop steps on trust demo fixture',
    { concurrency: false },
    async () => {
      const { readLiteTrustDemoFixture, resolveLiteTrustDemoFixturePath } =
        await import('../services/liteTrustDemo.js');
      const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
      const repo = mkdtempSync(join(tmpdir(), 'babel-session-fix-loop-'));
      try {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(
          join(repo, 'package.json'),
          JSON.stringify(
            {
              type: 'module',
              scripts: { test: 'node src/math.test.js' },
            },
            null,
            2,
          ),
          'utf-8',
        );
        writeFileSync(join(repo, fixture.target_file), fixture.broken_implementation, 'utf-8');
        writeFileSync(
          join(repo, 'src', 'math.test.js'),
          [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { add } from './math.js';",
            '',
            "test('add sums two numbers', () => {",
            '  assert.equal(add(1, 2), 3);',
            '});',
            '',
          ].join('\n'),
          'utf-8',
        );

        const session = new AgentSession({
          task: fixture.task,
          verb: 'fix',
          projectRoot: repo,
          provider: 'mock',
        });
        const result = await session.run();
        assert.equal(result.exitCode, 0);
        const payload = result.payload as {
          status?: string;
          execution_path?: string;
          session_loop_steps?: Array<{ phase: string }>;
        };
        assert.equal(payload.status, 'FIX_COMPLETE');
        assert.equal(payload.execution_path, 'session_loop');
        assert.ok((payload.session_loop_steps?.length ?? 0) >= 2);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('runs propose lane without manual bridge status', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-session-propose-'));
    try {
      const session = new AgentSession({
        task: 'Propose a README tweak',
        verb: 'propose',
        projectRoot: repo,
        provider: 'mock',
      });
      const result = await session.run();
      assert.equal(result.exitCode, 0);
      assert.notEqual((result.payload as { status?: string }).status, 'MANUAL_BRIDGE_REQUIRED');
      assert.equal((result.payload as { changed_files?: string[] }).changed_files?.length, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyAskGroundingReview, buildAskPrompt, runAskAnswerPath } from './askAnswer.js';
import type { AskAnswer } from '../schemas/agentContracts.js';

function makeRelicRunFixture(): { root: string; workspace: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'babel-ask-target-'));
  const workspace = join(root, 'example_game_suite');
  const target = join(workspace, 'relicRun');
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'README.md'),
    '# relicRun\n\nA roguelike extraction prototype built for Godot.\n',
    'utf-8',
  );
  writeFileSync(
    join(target, 'PROJECT_CONTEXT.md'),
    'RelicRun is the active child game project.\n',
    'utf-8',
  );
  writeFileSync(join(target, 'AGENTS.md'), 'Prefer target-local evidence.\n', 'utf-8');
  writeFileSync(join(target, 'package.json'), '{"name":"relic-run"}\n', 'utf-8');
  return { root, workspace, target };
}

function streamingChatResponse(content: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

test('ask prompt includes target-local evidence and shallow listing', async () => {
  const fixture = makeRelicRunFixture();
  try {
    const prompt = await buildAskPrompt({
      task: 'what is relicRun?',
      project: 'example_game_suite',
      projectRoot: fixture.target,
      workspaceRoot: fixture.workspace,
    });

    assert.equal(prompt.includes(`Target: ${fixture.target}`), true);
    assert.match(prompt, /Workspace root:/);
    assert.match(prompt, /Prioritize target-local files/);
    assert.match(prompt, /## Shallow Directory Listing/);
    assert.match(prompt, /\[file\] README\.md/);
    assert.match(prompt, /## Target Name Evidence/);
    assert.match(prompt, /## README\.md/);
    assert.match(prompt, /roguelike extraction prototype/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ask grounding review repairs unsupported absence claims using local target evidence', () => {
  const fixture = makeRelicRunFixture();
  try {
    const answer: AskAnswer = {
      schema_version: 1,
      status: 'ANSWER_READY',
      summary: 'relicRun was not recognized',
      answer: 'relicRun does not appear to be mentioned in the available project context.',
      facts: [],
      assumptions: ['relicRun is absent from the current workspace.'],
      evidence: [],
      next: [],
    };

    const result = applyAskGroundingReview(answer, {
      task: 'what is relicRun?',
      projectRoot: fixture.target,
      workspaceRoot: fixture.workspace,
    });

    assert.equal(result.review.status, 'repaired');
    assert.equal(result.review.contradiction, 'unsupported_absence_claim');
    assert.match(result.answer.answer, /relicRun is a roguelike extraction prototype/);
    assert.match(result.answer.facts.join('\n'), /relicRun exists at/);
    assert.doesNotMatch(result.answer.assumptions.join('\n'), /absent/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('streamed ask retries non-streaming after schema failure without preserving partial chunks', async () => {
  const fixture = makeRelicRunFixture();
  const originalFetch = globalThis.fetch;
  const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
  const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];
  const previousOffline = process.env['BABEL_LITE_OFFLINE'];
  let calls = 0;
  let resetCalled = false;
  let streamedText = '';
  const requestBodies: Array<{ stream?: boolean; model?: string }> = [];
  try {
    process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
    process.env['DEEPINFRA_API_KEY'] = 'test-key';
    process.env['BABEL_LITE_OFFLINE'] = '1';
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean; model?: string };
      requestBodies.push(body);
      if (calls === 1) {
        return streamingChatResponse(
          '{"schema_version":1,"status":"ANSWER_READY","summary":"partial","answer":"Partial',
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: 1,
                  status: 'ANSWER_READY',
                  summary: 'relicRun is a game project.',
                  answer: 'relicRun is a roguelike extraction prototype built for Godot.',
                  facts: ['README.md identifies relicRun.'],
                  assumptions: [],
                  evidence: ['README.md'],
                  next: ['Run bl plan "inspect relicRun architecture" for a deeper plan.'],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await runAskAnswerPath({
      task: 'what is relicRun?',
      projectRoot: fixture.target,
      workspaceRoot: fixture.workspace,
      model: 'deepseek-v4-flash',
      onChunk(chunk) {
        streamedText += chunk;
      },
      onStreamReset() {
        resetCalled = true;
        streamedText = '';
      },
    });

    assert.equal(calls, 2);
    assert.equal(requestBodies[0]?.stream, true);
    assert.equal(requestBodies[0]?.model, 'deepseek-v4-flash');
    assert.equal(requestBodies[1]?.stream, false);
    assert.equal(resetCalled, true);
    assert.equal(streamedText, '');
    assert.match(result.answer.answer, /roguelike extraction prototype/);
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
    if (previousOffline === undefined) {
      delete process.env['BABEL_LITE_OFFLINE'];
    } else {
      process.env['BABEL_LITE_OFFLINE'] = previousOffline;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

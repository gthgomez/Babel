import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runPlanLane } from './planLane.js';

describe('runPlanLane', () => {
  it('uses DeepSeek Pro planning and writes artifacts without mutating repo source files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-plan-lane-'));
    const source = join(repo, 'sample.txt');
    const originalFetch = globalThis.fetch;
    const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
    writeFileSync(source, 'before\n', 'utf-8');
    const beforeHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    let requestedModel = '';
    try {
      process.env['DEEPSEEK_API_KEY'] = 'test-key';
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
        requestedModel = body.model ?? '';
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                schema_version: 1,
                status: 'PLAN_READY',
                summary: 'Prepared a safe refactor plan.',
                answer: 'Review sample.txt, make the smallest refactor, and verify with npm test.',
                steps: ['Inspect sample.txt', 'Apply the smallest safe refactor', 'Run npm test'],
                likely_files: ['sample.txt'],
                risks: ['Keep the refactor scoped.'],
                verification: ['npm test'],
                next: ['Run bl fix "Apply the safe refactor" when ready.'],
              }),
            },
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        }), { status: 200 });
      }) as typeof fetch;

      const result = await runPlanLane({
        task: 'Plan a safe refactor',
        projectRoot: repo,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'PLAN_READY');
      assert.equal(result.payload.changed_files.length, 0);
      assert.equal(requestedModel, 'deepseek-v4-pro');
      assert.match(result.humanText, /^Babel Plan Ready/);
      assert.match(result.humanText, /Changed:\nnone/);
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
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

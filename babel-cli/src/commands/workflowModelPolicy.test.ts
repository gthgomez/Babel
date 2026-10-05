import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs';

import { preflightRequestedModelPolicy } from './workflowModelPolicy.js';

test('workflow preflight accepts an exact configured provider model id', () => {
  const policy = preflightRequestedModelPolicy('z-ai/glm-5.3-flash', {
    liveOnly: true,
  });

  assert.equal(policy.resolvedBackendKey, 'glm-5.3-flash');
  assert.equal(policy.provider, 'openrouter');
  assert.equal(policy.providerModelId, 'z-ai/glm-5.3-flash');
});

test('workflow preflight preserves configured backend-key resolution', () => {
  const policy = preflightRequestedModelPolicy('deepseek-v4-flash-openrouter', {
    liveOnly: true,
  });

  assert.equal(policy.resolvedBackendKey, 'deepseek-v4-flash-openrouter');
  assert.equal(policy.provider, 'openrouter');
  assert.equal(policy.providerModelId, 'deepseek/deepseek-v4-flash-0731');
});

for (const scenario of [
  { name: 'Chat backend selector', args: ['--mode', 'chat', '--model', 'opencode-go/deepseek-v4.1-flash'], admitted: true },
  { name: 'headless Chat provider model id', args: ['--mode', 'chat-headless', '--model', 'deepseek-v4.1-flash'], admitted: true },
  { name: 'legacy Chat pipeline', args: ['--mode', 'chat-headless', '--model', 'deepseek-v4.1-flash', '--use-chat-pipeline'], admitted: false },
  { name: 'Plan workflow', args: ['--mode', 'plan', '--model', 'deepseek-v4.1-flash'], admitted: false },
  { name: 'implicit read-only question', args: ['--model', 'deepseek-v4.1-flash'], admitted: false, task: 'What is this project?' },
]) {
  test(`CLI model admission preserves the ${scenario.name} boundary`, () => {
    const fixture = prepareSyntheticProviderFixture();
    try {
      const marker = join(fixture.root, 'dispatch.json');
      const preload = join(fixture.root, 'dispatch-probe.mjs');
      writeFileSync(preload, `import { writeFileSync } from 'node:fs'\n
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ url: String(url), model: body.model }));
          process.exit(77);
        };`);
      const child = spawnSync(process.execPath, [
        '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
        '--import', import.meta.resolve('tsx'),
        '--import', pathToFileURL(preload).href,
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        'run', ...scenario.args, '--execution-profile', 'safe_repo', '--json',
        '--project-root', fixture.cwd, scenario.task ?? 'Implement the requested repository repair and verify it.',
      ], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      assert.equal(child.error === undefined, true, 'synthetic CLI must complete before watchdog');
      assert.equal(existsSync(marker), scenario.admitted, 'dispatch admission must match the actual CLI path');
      if (scenario.admitted) {
        const dispatch = JSON.parse(readFileSync(marker, 'utf8')) as { url: string; model: string };
        assert.equal(child.status, 77, 'synthetic probe stops before a provider request');
        assert.equal(dispatch.url, 'https://opencode.ai/zen/go/v1/chat/completions');
        assert.equal(dispatch.model, 'deepseek-v4.1-flash');
      } else {
        assert.equal(child.status, 1);
        assert.equal(output.includes('[LIVE_MODEL_POLICY]'), true);
      }
    } finally {
      removeSyntheticProviderFixture(fixture.root);
    }
  });
}
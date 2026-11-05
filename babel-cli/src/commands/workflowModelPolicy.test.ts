import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs';

import { preflightRequestedModelPolicy } from './workflowModelPolicy.js';

test('the json flag wins over stream-json on early execution-scope refusal', () => {
  const fixture = prepareSyntheticProviderFixture();
  try {
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../index.ts', import.meta.url)),
      'run', '--execution-scope', 'invalid', '--model', 'glm-5.3-flash', '--json', '--output-format', 'stream-json', '--', 'No model request.',
    ], {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120_000,windowsHide:true});
    assert.equal(child.error,undefined);
    assert.equal(child.status,1);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status,'EXECUTOR_HALTED',String(result.error ?? result.message));
    assert.match(result.error,/execution scope/i);
  } finally { removeSyntheticProviderFixture(fixture.root); }
});

test('streaming Plan admission reports the exact Desktop model policy refusal as NDJSON', () => {
  const fixture = prepareSyntheticProviderFixture();
  try {
    const policy = JSON.parse(readFileSync(new URL('../../../config/model-policy.json', import.meta.url), 'utf8'));
    const model = 'openrouter/deepseek/deepseek-v4.1-flash';
    policy.models[model] = {provider:'openrouter',model_id:'deepseek/deepseek-v4.1-flash',tier:'standard',enabled:true,native_tool_use:true};
    const policyPath = join(fixture.root, 'model-policy.json');
    writeFileSync(policyPath, JSON.stringify(policy));
    const preload = join(fixture.root, 'desktop-route.mjs');
    writeFileSync(preload, `process.env.BABEL_MODEL_POLICY_PATH=${JSON.stringify(policyPath)};process.env.BABEL_DESKTOP_PROVIDER='openrouter';process.env.BABEL_DESKTOP_IPC='1';process.env.BABEL_DESKTOP_MODEL_ROUTE=${JSON.stringify(model)};`);
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../index.ts', import.meta.url)), 'run', '--mode', 'plan', '--model', model,
      '--output-format', 'stream-json', '--project-root', fixture.cwd, '--', 'Inspect this project and propose a plan. Do not modify files.',
    ], {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120_000,windowsHide:true});
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    const lines = child.stdout.trim().split('\n');
    assert.doesNotThrow(() => lines.map(line => JSON.parse(line)), 'each streaming stdout line must be valid JSON');
    const events = lines.map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ['run_error', 'turn.failed']);
    assert.match(events[0].error, /LIVE_MODEL_POLICY/);
    assert.match(events[0].error, /deepseek-v4\.1-flash/);
    assert.equal(events[0].result.status, 'EXECUTOR_HALTED');
  } finally { removeSyntheticProviderFixture(fixture.root); }
});

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

test('workflow preflight resolves the standard DeepSeek Flash default through OpenRouter', () => {
  const policy = preflightRequestedModelPolicy('deepseek-v4.1-flash-openrouter', {
    liveOnly: true,
  });

  assert.equal(policy.resolvedBackendKey, 'deepseek-v4.1-flash-openrouter');
  assert.equal(policy.provider, 'openrouter');
  assert.equal(policy.providerModelId, 'deepseek/deepseek-v4.1-flash-1017');
});

for (const scenario of [
  { name: 'Chat backend selector', args: ['--mode', 'chat', '--model', 'opencode-go/deepseek-v4.1-flash'], admitted: true },
  { name: 'headless Chat provider model id', args: ['--mode', 'chat-headless', '--model', 'deepseek-v4.1-flash'], admitted: true },
  { name: 'legacy Chat pipeline', args: ['--mode', 'chat-headless', '--model', 'deepseek-v4.1-flash', '--use-chat-pipeline'], admitted: false },
  { name: 'Plan workflow', args: ['--mode', 'plan', '--model', 'deepseek-v4.1-flash'], admitted: false },
  { name: 'Command Code Chat selector', args: ['--mode', 'chat', '--model', 'command-code/deepseek-v4.1-flash'], admitted: true, provider: 'command-code' },
  { name: 'Command Code read-only shorthand', args: ['--model', 'command-code/deepseek-v4.1-flash'], admitted: true, provider: 'command-code', task: 'Inspect REPO_MAP.md without editing files.' },
  { name: 'Command Code legacy pipeline', args: ['--mode', 'chat', '--model', 'command-code/deepseek-v4.1-flash', '--use-chat-pipeline'], admitted: false },
  { name: 'Command Code Plan', args: ['--mode', 'plan', '--model', 'command-code/deepseek-v4.1-flash'], admitted: false },
  { name: 'unknown Command Code model', args: ['--model', 'command-code/not-configured'], admitted: false, task: 'Inspect REPO_MAP.md without editing files.' },
  { name: 'implicit read-only question', args: ['--model', 'deepseek-v4.1-flash'], admitted: false, task: 'What is this project?' },
]) {
  test(`CLI model admission preserves the ${scenario.name} boundary`, () => {
    const fixture = prepareSyntheticProviderFixture();
    try {
      const marker = join(fixture.root, 'dispatch.json');
      const preload = join(fixture.root, 'dispatch-probe.mjs');
      writeFileSync(preload, `import { writeFileSync } from 'node:fs'\nprocess.env.COMMAND_CODE_API_KEY = 'synthetic-command-code-only';\n
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ url: String(url), model: body.model }));
          process.exit(77);
        };`);
      const child = spawnSync(process.execPath, [
        '--experimental-wasm-modules',
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
        assert.equal(dispatch.url, scenario.provider === 'command-code' ? 'https://api.commandcode.ai/provider/v1/chat/completions' : 'https://opencode.ai/zen/go/v1/chat/completions');
        assert.equal(dispatch.model, scenario.provider === 'command-code' ? 'deepseek/deepseek-v4.1-flash' : 'deepseek-v4.1-flash');
      } else {
        assert.equal(child.status, 1);
        assert.equal(output.includes('[LIVE_MODEL_POLICY]') || output.includes('not-configured'), true);
      }
    } finally {
      removeSyntheticProviderFixture(fixture.root);
    }
  });
}

for (const file of ['REPO_MAP.md', 'MODULE_INDEX.md']) {
  test(`Command Code shorthand inspects ${file}, preserves answer and rejects mutation`, () => {
    const fixture = prepareSyntheticProviderFixture();
    try {
      writeFileSync(join(fixture.cwd, file), `source-owned-observation-${file}\n`);
      const evidence = join(fixture.root, 'native-observation.json');
      const preload = join(fixture.root, 'native-response.mjs');
      writeFileSync(preload, `import assert from 'node:assert/strict';
        import { writeFileSync } from 'node:fs';
        process.env.COMMAND_CODE_API_KEY = 'synthetic-command-code-only';
        let calls = 0;
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(String(url), 'https://api.commandcode.ai/provider/v1/chat/completions');
          assert.equal(body.model, 'deepseek/deepseek-v4.1-flash');
          const names = (body.tools ?? []).map(x => x.function.name);
          assert.equal(names.includes('read_file'), true);
          assert.equal(names.includes('write_file'), false);
          calls++;
          let delta, finish = 'tool_calls';
          if (calls === 1) delta = { tool_calls: [{ index: 0, id: 'read-index', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: ${JSON.stringify(file)} }) } }] };
          else if (calls === 2) {
            assert.ok(JSON.stringify(body.messages).includes(${JSON.stringify(`source-owned-observation-${file}`)}));
            delta = { tool_calls: [{ index: 0, id: 'attempt-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'unauthorized.txt', content: 'must not write' }) } }] };
          } else {
            assert.equal(calls, 3);
            delta = { content: ${JSON.stringify(`Inspected ${file}: source-owned-observation-${file}. No files were edited.`)} };
            finish = 'stop';
          }
          writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ calls, names }));
          return new Response('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
        };
      `);
      const child = spawnSync(process.execPath, [
        '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
        '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
        fileURLToPath(new URL('../index.ts', import.meta.url)), 'run',
        `Inspect ${file} and report what it contains without editing files.`,
        '--model', 'command-code/deepseek-v4.1-flash', '--project-root', fixture.cwd, '--json',
      ], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
      assert.equal(child.error, undefined, 'native CLI must complete before watchdog');
      assert.equal(child.status, 0, 'native CLI must deliver a useful inspection answer');
      const payload = JSON.parse(child.stdout);
      assert.equal(payload.terminal_outcome, 'NO_CHANGE_REQUIRED');
      assert.ok(payload.answer.answer.includes(`source-owned-observation-${file}`));
      assert.equal(JSON.parse(readFileSync(evidence, 'utf8')).calls, 3);
      assert.equal(existsSync(join(fixture.cwd, 'unauthorized.txt')), false);
      assert.equal(readFileSync(join(fixture.cwd, file), 'utf8'), `source-owned-observation-${file}\n`);
      assert.ok(payload.toolCalls.some((call: { tool: string }) => call.tool === 'read_file'));
    } finally { removeSyntheticProviderFixture(fixture.root); }
  });
}

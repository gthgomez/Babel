import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs';

for (const [name, task, admitted] of [
  ['no-publication edit', 'Fix the incorrect zero-match glob feedback using the existing tests. Do not commit, push, change credentials/security settings, or make unrelated edits.', true],
  ['explanatory quote', 'Explain this example: \"Commit and push this feature branch.\" Do not execute it.', true],
  ['positive action after quote', 'Explain this example: \"Commit and push this feature branch.\" Then commit and push this feature branch.', false],
] as const) test(`ordinary native CLI publication intent: ${name}`, () => {
  const fixture = prepareSyntheticProviderFixture();
  try {
    const marker = join(fixture.root, 'dispatch.json');
    const preload = join(fixture.root, 'probe.mjs');
    writeFileSync(preload, `import { writeFileSync } from 'node:fs';
      process.env.COMMAND_CODE_API_KEY = 'synthetic-command-code-only';
      globalThis.fetch = async (url, init) => {
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ url: String(url), model: JSON.parse(init.body).model }));
        process.exit(77);
      };`);
    const child = spawnSync(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../index.ts', import.meta.url)), 'run', '--mode', 'chat', task,
      '--model', 'command-code/deepseek-v4.1-flash', '--project-root', fixture.cwd, '--json',
    ], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, admitted ? 77 : 1, 'probe stops before any provider request');
    assert.equal(existsSync(marker), admitted);
    if (!admitted) { assert.match(child.stdout, /DENY_MISSING_AUTHORITY/); return; }
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
      url: 'https://api.commandcode.ai/provider/v1/chat/completions', model: 'deepseek/deepseek-v4.1-flash',
    });
  } finally { removeSyntheticProviderFixture(fixture.root); }
});

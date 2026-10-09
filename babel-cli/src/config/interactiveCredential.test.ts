import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybePromptForMissingProviderCredential } from './interactiveCredential.js';

test('maybePromptForMissingProviderCredential is a no-op for machine output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-interactive-cred-'));
  const env: NodeJS.ProcessEnv = {
    BABEL_CONFIG_DIR: join(root, 'config'),
    OPENROUTER_API_KEY: '',
  };
  delete env.OPENROUTER_API_KEY;
  await maybePromptForMissingProviderCredential(env, ['node', 'babel', 'run', 'hello', '--json']);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  rmSync(root, { recursive: true, force: true });
});

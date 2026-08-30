import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const runnersDir = dirname(fileURLToPath(import.meta.url));

function source(name: string): string {
  return readFileSync(resolve(runnersDir, name), 'utf8');
}

test('OpenRouter runtime is not coupled to DeepInfra compatibility settings', () => {
  const openRouter = source('openRouterApi.ts');
  const neutral = source('openAiCompatibleApi.ts');
  const deepInfra = source('deepInfraApi.ts');

  assert.match(openRouter, /extends OpenAICompatibleApiRunner/);
  assert.doesNotMatch(openRouter, /deepInfraApi|DeepInfra|BABEL_DEEPINFRA/);
  assert.doesNotMatch(neutral, /BABEL_DEEPINFRA/);
  assert.doesNotMatch(neutral, /extends DeepInfraApiRunner/);
  assert.match(deepInfra, /extends OpenAICompatibleApiRunner/);
  assert.match(deepInfra, /environmentPrefix: 'BABEL_DEEPINFRA'/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { rewriteArgv } from '../cli/argv.js';

test('every former daily natural-language usability scenario reaches current chat with its task intact', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/lite-usability/scenarios.json', import.meta.url), 'utf8')) as {
    scenarios: Array<{ lite_command: string[]; full_command: string[]; expected_route: string; user_goal: string }>;
  };
  const dailyScenarios = fixture.scenarios.filter(scenario => scenario.expected_route === 'daily');
  assert.ok(dailyScenarios.length >= 5, 'Retain the natural-language usability inventory');
  for (const scenario of dailyScenarios) {
    assert.deepEqual(rewriteArgv(['node', ...scenario.lite_command]), ['node', 'babel', 'run', '--mode', 'chat', scenario.user_goal]);
    assert.ok(scenario.lite_command.length < scenario.full_command.length, 'The shorter invocation must retain its task');
  }
});

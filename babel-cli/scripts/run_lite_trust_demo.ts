import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readLiteTrustDemoFixture,
  resolveBabelCliEntry,
  resolveLiteTrustDemoFixturePath,
  runLiteTrustDemo,
} from '../src/services/liteTrustDemo.js';

function writeTrustDemoRepo(root: string, implementation: string, targetFile: string): void {
  const targetDir = join(root, targetFile.split('/').slice(0, -1).join('/'));
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, targetFile), implementation, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'), 'utf-8');
}

async function main(): Promise<void> {
  const fixturePath = resolveLiteTrustDemoFixturePath();
  const fixture = readLiteTrustDemoFixture(fixturePath);
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-trust-demo-script-'));
  try {
    writeTrustDemoRepo(root, fixture.broken_implementation, fixture.target_file);
    const result = await runLiteTrustDemo({
      projectRoot: root,
      fixturePath,
      cliEntry: resolveBabelCliEntry(),
    });
    const lines = [
      'Babel Lite Trust Demo (CLI path)',
      `Status: ${result.status}`,
      `Execution mode: ${result.execution_mode ?? '<none>'}`,
      `Run dir: ${result.run_dir ?? '<none>'}`,
      `Scenarios: ${result.scenarios.map(scenario => `${scenario.scenario_id}=${scenario.status}`).join(', ')}`,
      '',
      ...result.steps.map(step => `${step.status.toUpperCase().padEnd(4)} ${step.name}: ${step.detail}`),
    ];
    console.log(lines.join('\n'));
    if (result.status !== 'pass') {
      process.exitCode = 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

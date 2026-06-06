import { config as dotenvConfig } from 'dotenv';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSmallFixPath } from '../src/services/smallFix.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenvConfig({
  path: join(packageRoot, '.env'),
  override: false,
  quiet: true,
});

function writeNodeFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');
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
  if (!process.env['DEEPINFRA_API_KEY']?.trim()) {
    console.log('[test:live-small-fix:optional] skipped — DEEPINFRA_API_KEY is not set');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'babel-live-small-fix-'));
  try {
    writeNodeFixture(root);
    process.env['BABEL_PROJECT_ROOT'] = root;

    const result = await runSmallFixPath({
      projectRoot: root,
      provider: 'live',
      model: 'deepseek',
      modelTier: 'standard',
      task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
    });

    console.log('[test:live-small-fix:optional] status:', result.status);
    console.log('[test:live-small-fix:optional] execution_mode:', result.executionMode ?? '<none>');
    console.log('[test:live-small-fix:optional] run_dir:', result.runDir);

    if (result.status !== 'SMALL_FIX_COMPLETE') {
      console.error('[test:live-small-fix:optional] failed — live small fix did not complete');
      process.exitCode = 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('[test:live-small-fix:optional] failed —', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

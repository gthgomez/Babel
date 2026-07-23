import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRealTaskPilotReport, formatRealTaskPilotHuman } from './realTaskPilot.js';

test('real-task pilot writes a concrete non-mutating pilot plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-real-task-pilot-'));
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-real-task-your_XXXXXXXXXXXXXXXXXXXX'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        {
          type: 'module',
          scripts: { test: 'node --test' },
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'index.js'), 'export const ok = true;\n', 'utf-8');

    const report = buildRealTaskPilotReport({
      projectRoot: root,
      outputDir,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.equal(report.report_type, 'babel_real_task_pilot');
    assert.equal(report.repo.test_command, 'npm test');
    assert.equal(report.cases.length, 5);
    assert.equal(
      report.cases.some((testCase) => testCase.id === 'multi_file_verified_stress'),
      true,
    );
    assert.equal(existsSync(report.artifact_path), true);
    const human = formatRealTaskPilotHuman(report);
    assert.match(human, /Run the read-only cases first/);
    assert.match(human, /babel run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

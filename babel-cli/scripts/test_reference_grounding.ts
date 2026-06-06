import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTaskGrounding,
  classifyTaskContract,
  formatGroundingContext,
} from '../src/taskCompletion.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'babel-reference-grounding-'));
  const projectRoot = join(tempRoot, 'BabelMonteCarloAutonomousTest');

  try {
    mkdirSync(join(projectRoot, 'app', 'src', 'main', 'java', 'com', 'example', 'app'), { recursive: true });
    mkdirSync(join(projectRoot, 'reference-Example Finance Forecast', 'monte_carlo_ledger'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'app', 'src', 'main', 'java', 'com', 'example', 'app', 'MainActivity.kt'),
      'package com.example.app\n\nclass MainActivity\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-Example Finance Forecast', 'README.md'),
      '# Monte Carlo Ledger\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-Example Finance Forecast', 'pyproject.toml'),
      '[project]\nname = "monte-carlo-ledger"\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-Example Finance Forecast', 'monte_carlo_ledger', 'forecasting.py'),
      'def project_cashflow():\n    return []\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-Example Finance Forecast', 'monte_carlo_ledger', 'risk.py'),
      'def calculate_risk():\n    return {}\n',
      'utf-8',
    );

    const taskContract = classifyTaskContract(
      'Inside this Android project, port the source app from ./reference-Example Finance Forecast into a production-ready Android mobile app.',
    );
    const grounding = buildTaskGrounding(taskContract, projectRoot);
    const groundingContext = formatGroundingContext(grounding);

    assert(grounding !== null, 'expected reference grounding to be created');
    assert(grounding.grounded === true, 'expected reference grounding to mark files as grounded');
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-Example Finance Forecast\\README.md')),
      'expected grounded files to include reference README.md',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-Example Finance Forecast\\pyproject.toml')),
      'expected grounded files to include reference pyproject.toml',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-Example Finance Forecast\\monte_carlo_ledger\\forecasting.py')),
      'expected grounded files to include reference forecasting.py',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-Example Finance Forecast\\monte_carlo_ledger\\risk.py')),
      'expected grounded files to include reference risk.py',
    );
    assert(
      groundingContext.includes('reference-Example Finance Forecast/monte_carlo_ledger/forecasting.py') &&
      groundingContext.includes('Reference source inventories (use these real filenames instead of guessing module names):'),
      'expected grounding context to surface the authoritative Python source inventory',
    );

    console.log('reference grounding regression test passed');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

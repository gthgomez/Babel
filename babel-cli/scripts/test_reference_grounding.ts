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
    mkdirSync(join(projectRoot, 'reference-montecarlo-ledger', 'reference_package_ledger'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'app', 'src', 'main', 'java', 'com', 'example', 'app', 'MainActivity.kt'),
      'package com.example.app\n\nclass MainActivity\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-montecarlo-ledger', 'README.md'),
      '# Monte Carlo Ledger\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-montecarlo-ledger', 'pyproject.toml'),
      '[project]\nname = "monte-carlo-ledger"\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-montecarlo-ledger', 'reference_package_ledger', 'forecasting.py'),
      'def project_cashflow():\n    return []\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-montecarlo-ledger', 'reference_package_ledger', 'risk.py'),
      'def calculate_risk():\n    return {}\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-montecarlo-ledger', 'root_utils.py'),
      'def normalize_value(value):\n    return value\n',
      'utf-8',
    );
    writeFileSync(join(tempRoot, 'outside_reference.py'), 'raise RuntimeError("out of scope")\n', 'utf-8');
    for (const moduleName of ['models.py', 'engine.py']) {
      writeFileSync(
        join(projectRoot, 'reference-montecarlo-ledger', 'reference_package_ledger', moduleName),
        'class Fixture:\n    pass\n',
        'utf-8',
      );
    }

    const taskContract = classifyTaskContract(
      'Inside this Android project, port the source app from ./reference-montecarlo-ledger into a production-ready Android mobile app.',
    );
    const grounding = buildTaskGrounding(taskContract, projectRoot);
    const groundingContext = formatGroundingContext(grounding);

    assert(grounding !== null, 'expected reference grounding to be created');
    assert(grounding.grounded === true, 'expected reference grounding to mark files as grounded');
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-montecarlo-ledger\\README.md')),
      'expected grounded files to include reference README.md',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-montecarlo-ledger\\pyproject.toml')),
      'expected grounded files to include reference pyproject.toml',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-montecarlo-ledger\\reference_package_ledger\\forecasting.py')),
      'expected grounded files to include reference forecasting.py',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-montecarlo-ledger\\reference_package_ledger\\risk.py')),
      'expected grounded files to include reference risk.py',
    );
    assert(
      groundingContext.includes('reference-montecarlo-ledger/reference_package_ledger/forecasting.py') &&
      groundingContext.includes('Reference source inventories:') &&
      groundingContext.includes('closed source module inventory'),
      'expected grounding context to surface the authoritative Python source inventory',
    );
    assert(
      groundingContext.includes('root_utils.py') &&
      groundingContext.includes('reference_package_ledger/risk.py'),
      'expected the module inventory to include actual root and nested Python paths',
    );
    assert(
      grounding.files.every((filePath: string) => filePath.startsWith(projectRoot)) &&
      !groundingContext.includes('outside_reference.py'),
      'expected reference inventory to remain inside the explicitly grounded project',
    );

    const absoluteAllowlist = grounding.referenceInventorySnippets[0] ?? '';
    assert(
      absoluteAllowlist.includes(join(projectRoot, 'reference-montecarlo-ledger', 'root_utils.py')),
      'expected the closed absolute allowlist to include root-level Python files',
    );
    assert(
      groundingContext.includes('reference_package_ledger/models.py') &&
      groundingContext.includes('reference_package_ledger/engine.py') &&
      !groundingContext.includes('models.py or engine.py; they are not present'),
      'expected guidance to accept actual module names instead of claiming they are absent',
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

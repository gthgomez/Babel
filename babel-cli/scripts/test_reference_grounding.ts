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
  const projectRoot = join(tempRoot, 'BabelReferenceGroundingTest');

  try {
    mkdirSync(join(projectRoot, 'app', 'src', 'main', 'java', 'com', 'example', 'app'), { recursive: true });
    mkdirSync(join(projectRoot, 'reference-source', 'reference_source'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'app', 'src', 'main', 'java', 'com', 'example', 'app', 'MainActivity.kt'),
      'package com.example.app\n\nclass MainActivity\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-source', 'README.md'),
      '# Reference Source\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-source', 'pyproject.toml'),
      '[project]\nname = "reference-source"\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-source', 'reference_source', 'processing.py'),
      'def process_records():\n    return []\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'reference-source', 'reference_source', 'validation.py'),
      'def validate_records():\n    return {}\n',
      'utf-8',
    );

    const taskContract = classifyTaskContract(
      'Inside this Android project, port the source app from ./reference-source into a release-build Android mobile app.',
    );
    const grounding = buildTaskGrounding(taskContract, projectRoot);
    const groundingContext = formatGroundingContext(grounding);

    assert(grounding !== null, 'expected reference grounding to be created');
    assert(grounding.grounded === true, 'expected reference grounding to mark files as grounded');
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-source\\README.md')),
      'expected grounded files to include reference README.md',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-source\\pyproject.toml')),
      'expected grounded files to include reference pyproject.toml',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-source\\reference_source\\processing.py')),
      'expected grounded files to include reference processing.py',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('reference-source\\reference_source\\validation.py')),
      'expected grounded files to include reference validation.py',
    );
    assert(
      groundingContext.includes('reference-source/reference_source/processing.py') &&
      groundingContext.includes('Reference source file_read allowlist (closed; use only these exact paths instead of guessing module names):'),
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

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function runPreviewScript(args: string[], cliRoot: string): { status: number | null; stdout: string; stderr: string } {
  const tsxBinary = join(
    cliRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );

  const result = spawnSync(
    tsxBinary,
    ['scripts/preview_manifest.ts', ...args],
    {
      cwd: cliRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = resolve(scriptDir, '..');
  const repoRoot = resolve(cliRoot, '..');
  const fixturesRoot = join(repoRoot, 'examples', 'manifest-previews');

  const backendExpected = JSON.parse(
    readFileSync(join(fixturesRoot, 'backend-verified.json'), 'utf8'),
  ) as Record<string, unknown>;
  const backendActual = runPreviewScript([
    '--task-category', 'backend',
    '--project', 'example_saas_backend',
    '--model', 'codex',
    '--pipeline-mode', 'verified',
    '--root', repoRoot,
  ], cliRoot);
  assert(
    backendActual.status === 0,
    `backend manifest preview should succeed. stderr=${backendActual.stderr}`,
  );
  assert(
    JSON.stringify(JSON.parse(backendActual.stdout)) === JSON.stringify(backendExpected),
    'backend manifest preview should match the golden output',
  );

  const mobileExpected = JSON.parse(
    readFileSync(join(fixturesRoot, 'mobile-pdf-direct.json'), 'utf8'),
  ) as Record<string, unknown>;
  const mobileActual = runPreviewScript([
    '--task-category', 'mobile',
    '--project', 'example_mobile_suite',
    '--model', 'codex',
    '--skill-id', 'skill_android_pdf_processing',
    '--root', repoRoot,
  ], cliRoot);
  assert(
    mobileActual.status === 0,
    `mobile manifest preview should succeed. stderr=${mobileActual.stderr}`,
  );
  assert(
    JSON.stringify(JSON.parse(mobileActual.stdout)) === JSON.stringify(mobileExpected),
    'mobile manifest preview should match the golden output',
  );

  const conflictActual = runPreviewScript([
    '--task-category', 'frontend',
    '--model', 'codex',
    '--skill-id', 'skill_react_nextjs',
    '--skill-id', 'skill_vite_react',
    '--root', repoRoot,
  ], cliRoot);
  assert(conflictActual.status !== 0, 'conflicting manifest preview should fail');
  const conflictText = `${conflictActual.stdout}\n${conflictActual.stderr}`;
  assert(
    conflictText.includes('Conflicting catalog ids selected together'),
    `conflicting manifest preview should surface the resolver conflict. output=${conflictText}`,
  );

  console.log('manifest preview regression tests passed');
}

main();


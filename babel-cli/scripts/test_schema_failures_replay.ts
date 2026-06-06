import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(packageRoot, 'scripts', 'test_governance_proof_replay.ts');

function main(): void {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--no-warnings=ExperimentalWarning',
      scriptPath,
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        BABEL_SCHEMA_FAILURE_SCENARIOS: 'malformed-plan-halts',
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();

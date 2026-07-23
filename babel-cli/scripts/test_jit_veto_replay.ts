/**
 * Offline JIT veto proof replay — recorded streaming fixtures, no network, no TTY.
 * Exercises the full IncrementalToolDetector + human JIT veto flow.
 * Patterns mirror scripts/test_governance_proof_replay.ts.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(
  packageRoot,
  'src',
  'fixtures',
  'jit-veto',
  'recorded-jit-streams.json',
);
const proofTestFile = join(packageRoot, 'src', 'services', 'jitVetoProof.test.ts');

interface FixtureSet {
  fixture_set_id: string;
  scenarios: Array<{ id: string }>;
}

interface ProofSummary {
  fixture_set_id: string;
  scenario_count: number;
  scenario_ids: string[];
  passed: number;
  failed: number;
  artifact_root: string;
}

function main(): void {
  const fixtures: FixtureSet = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const proofRoot = mkdtempSync(join(tmpdir(), 'babel-jit-veto-replay-'));

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import', 'tsx',
        '--no-warnings=ExperimentalWarning',
        '--test',
        proofTestFile,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          BABEL_JIT_VETO_PROOF_ROOT: proofRoot,
        },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) {
      // Filter out JIT APPROVAL prompts from noise view
      const filtered = result.stderr
        .split('\n')
        .filter(line => !line.includes('[JIT APPROVAL]'))
        .join('\n');
      if (filtered.trim()) process.stderr.write(filtered + '\n');
    }

    const summaryPath = join(proofRoot, 'proof-summary.json');
    if (result.status !== 0) {
      console.error(`[jit-veto-replay] FAILED (exit ${result.status})`);
      process.exit(result.status ?? 1);
    }
    if (!existsSync(summaryPath)) {
      console.error(`[jit-veto-replay] FAILED — missing proof summary at ${summaryPath}`);
      process.exit(1);
    }

    const summary: ProofSummary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    if (summary.failed > 0) {
      console.error(`[jit-veto-replay] FAILED — ${summary.failed}/${summary.scenario_count} scenarios failed`);
      process.exit(1);
    }

    console.log('[jit-veto-replay] PASS — offline JIT veto replay');
    console.log(`  fixture_set_id: ${summary.fixture_set_id}`);
    console.log(`  scenarios: ${summary.scenario_count} (${summary.scenario_ids.join(', ')})`);
    console.log(`  passed: ${summary.passed}, failed: ${summary.failed}`);
    console.log(`  artifacts: ${proofRoot}`);
  } finally {
    rmSync(proofRoot, { recursive: true, force: true });
  }
}

main();

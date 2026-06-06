/**
 * Offline governance proof replay — recorded provider fixtures, no network.
 * Patterns mirror src/services/liveGovernanceProof.test.ts.
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
  'live-governance',
  'recorded-provider-scenarios.json',
);
const proofTestFile = join(packageRoot, 'src', 'services', 'liveGovernanceProof.test.ts');

interface RecordedFixtureSet {
  fixture_set_id: string;
  provider_mode: string;
  live_provider_unavailable_artifact: string;
  scenarios: Array<{ id: string; expected_terminal_status: string }>;
}

interface ProofSummary {
  fixture_set_id: string;
  scenario_count: number;
  scenario_ids: string[];
  provider_mode: string;
  live_provider_unavailable: boolean;
  artifact_root: string;
}

function liveProviderKeyStatus(): string {
  if (process.env['DEEPSEEK_API_KEY']) {
    return 'DEEPSEEK_API_KEY present (replay still offline)';
  }
  if (process.env['DEEPINFRA_API_KEY']) {
    return 'DEEPINFRA_API_KEY present (replay still offline)';
  }
  return 'absent';
}

function loadFixtureMeta(): RecordedFixtureSet {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as RecordedFixtureSet;
}

function main(): void {
  const fixtures = loadFixtureMeta();
  const proofRoot = mkdtempSync(join(tmpdir(), 'babel-governance-replay-'));

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--no-warnings=ExperimentalWarning',
        '--test',
        proofTestFile,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          BABEL_LIVE_GOVERNANCE_PROOF_ROOT: proofRoot,
        },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    const summaryPath = join(proofRoot, 'proof-summary.json');
    const liveKeyPresent = Boolean(process.env['DEEPSEEK_API_KEY'] || process.env['DEEPINFRA_API_KEY']);

    if (result.status !== 0) {
      console.error(
        `[governance-replay] FAILED (exit ${result.status ?? 'null'}) — recorded provider scenarios did not pass`,
      );
      process.exit(result.status ?? 1);
    }

    if (!existsSync(summaryPath)) {
      console.error(`[governance-replay] FAILED — missing proof summary at ${summaryPath}`);
      process.exit(1);
    }

    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as ProofSummary;

    console.log('[governance-replay] PASS — offline recorded-provider replay');
    console.log(`  fixture_set_id: ${summary.fixture_set_id}`);
    console.log(`  scenarios: ${summary.scenario_count} (${summary.scenario_ids.join(', ')})`);
    console.log(`  provider_mode: ${summary.provider_mode}`);
    console.log(`  live_provider_key: ${liveProviderKeyStatus()}`);
    if (!liveKeyPresent) {
      console.log(`  live_provider_note: ${fixtures.live_provider_unavailable_artifact}`);
    }
    for (const scenario of fixtures.scenarios) {
      console.log(`  - ${scenario.id} -> expected ${scenario.expected_terminal_status}`);
    }
    console.log(`  artifact_root: ${summary.artifact_root}`);
  } finally {
    rmSync(proofRoot, { recursive: true, force: true });
  }
}

main();

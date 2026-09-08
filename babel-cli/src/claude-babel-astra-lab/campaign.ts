import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_ACTIVE_WORKER_HARNESSES, type AstraComparisonPacket, type ControlledRun } from './contracts.js';
import { buildAstraComparisonPacket } from './comparison.js';
import { BENCHMARK_PROFILES, type BenchmarkProfile, type OpenCodeGoModel } from './models.js';
import type { FixtureTaskId } from '../fixtures/claude-babel-astra-lab/fixtures.js';

export interface PilotCase {
  experimentId: string;
  pairId: string;
  taskId: FixtureTaskId;
  profile: BenchmarkProfile;
  model: OpenCodeGoModel;
  sequence: number;
}

export interface HarnessRunAdapter {
  run(input: PilotCase & { harness: 'claude-code' | 'babel-live' }): Promise<ControlledRun>;
}

export function buildPilotMatrix(profile: BenchmarkProfile = 'benchmark-mimo'): PilotCase[] {
  const model = BENCHMARK_PROFILES[profile];
  return (['T1', 'T2', 'T4'] as const).flatMap((taskId, index) => {
    return [{ experimentId: 'claude-babel-astra-lab', pairId: `${profile}-${taskId.toLowerCase()}`, taskId, profile, model, sequence: index }];
  });
}

export function buildCertificationMatrix(): PilotCase[] {
  return (Object.keys(BENCHMARK_PROFILES) as BenchmarkProfile[]).flatMap((profile, index) =>
    buildPilotMatrix(profile).map((pilotCase) => ({ ...pilotCase, sequence: index * 3 + pilotCase.sequence })),
  );
}

/** Run each pair’s Claude and Babel cases strictly one at a time (6 runs per profile). */
export async function runSequentialPilot(
  cases: readonly PilotCase[],
  adapters: Readonly<Record<'claude-code' | 'babel-live', HarnessRunAdapter>>,
): Promise<ControlledRun[]> {
  const results: ControlledRun[] = [];
  let active = 0;
  for (const pilotCase of cases) {
    for (const harness of ['claude-code', 'babel-live'] as const) {
      if (active >= MAX_ACTIVE_WORKER_HARNESSES) throw new Error('POLICY_FAILURE: MAX_ACTIVE_WORKER_HARNESSES=1');
      active += 1;
      try {
        results.push(await adapters[harness].run({ ...pilotCase, harness }));
      } finally {
        active -= 1;
      }
    }
  }
  return results;
}

export function writeAstraComparisonPacket(path: string, packet: AstraComparisonPacket): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function pairPilotResults(claude: ControlledRun, babel: ControlledRun): AstraComparisonPacket {
  if (claude.exactModel !== babel.exactModel) throw new Error('INVALID_CONTROLLED_PAIR: model mismatch');
  return buildAstraComparisonPacket(claude.receipt.TASK_ID, claude.exactModel, claude, babel);
}

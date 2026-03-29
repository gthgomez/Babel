import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface RuntimeTelemetryRecord {
  orchestrator_version: '8.0' | '9.0';
  domain_id: string;
  skill_ids: string[];
  model_adapter_id: string;
  selected_entry_ids: string[];
  token_budget_total: number | null;
  token_budget_missing_count: number;
  budget_warning_severity: 'info' | 'warn' | 'severe' | null;
  budget_policy_enabled: boolean;
  pipeline_mode: 'direct' | 'verified' | 'autonomous' | 'manual';
  qa_verdict: 'PASS' | 'REJECT' | null;
  qa_failure_tags: string[];
  final_outcome: string | null;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const babelRoot = resolve(scriptDir, '..', '..');
  const runsDir = process.env['BABEL_RUNS_DIR'] ?? join(babelRoot, 'runs');
  const limit = toNumber(process.argv[2], 50);

  const runDirectories = readdirSync(runsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const fullPath = join(runsDir, entry.name);
      return {
        name: entry.name,
        fullPath,
        mtimeMs: statSync(fullPath).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);

  const records: Array<{
    run_dir: string;
    telemetry: RuntimeTelemetryRecord;
  }> = [];

  for (const runDirectory of runDirectories) {
    const telemetryPath = join(runDirectory.fullPath, '06_runtime_telemetry.json');
    if (!existsSync(telemetryPath)) {
      continue;
    }

    try {
      const telemetry = JSON.parse(readFileSync(telemetryPath, 'utf-8')) as RuntimeTelemetryRecord;
      if (telemetry.orchestrator_version !== '9.0') {
        continue;
      }
      records.push({
        run_dir: runDirectory.fullPath,
        telemetry,
      });
    } catch {
      continue;
    }
  }

  const averageBudgetByDomain = Object.fromEntries(
    Array.from(
      records.reduce((map, record) => {
        const bucket = map.get(record.telemetry.domain_id) ?? [];
        if (typeof record.telemetry.token_budget_total === 'number') {
          bucket.push(record.telemetry.token_budget_total);
        }
        map.set(record.telemetry.domain_id, bucket);
        return map;
      }, new Map<string, number[]>()),
    ).map(([domainId, totals]) => [
      domainId,
      average(totals),
    ]),
  );

  const highestBudgetStacks = records
    .filter(record => typeof record.telemetry.token_budget_total === 'number')
    .sort((left, right) => (right.telemetry.token_budget_total ?? 0) - (left.telemetry.token_budget_total ?? 0))
    .slice(0, 5)
    .map(record => ({
      run_dir: record.run_dir,
      domain_id: record.telemetry.domain_id,
      selected_entry_ids: record.telemetry.selected_entry_ids,
      token_budget_total: record.telemetry.token_budget_total,
      budget_warning_severity: record.telemetry.budget_warning_severity,
      final_outcome: record.telemetry.final_outcome,
    }));

  const warningFrequency = records.reduce<Record<string, number>>((accumulator, record) => {
    const severity = record.telemetry.budget_warning_severity ?? 'none';
    accumulator[severity] = (accumulator[severity] ?? 0) + 1;
    return accumulator;
  }, {});

  const qaPassRateByStack = Array.from(
    records.reduce((map, record) => {
      const stackKey = record.telemetry.selected_entry_ids.join(' | ');
      const current = map.get(stackKey) ?? {
        stack_key: stackKey,
        pass_runs: 0,
        total_runs: 0,
      };

      current.total_runs += 1;
      if (record.telemetry.qa_verdict === 'PASS') {
        current.pass_runs += 1;
      }

      map.set(stackKey, current);
      return map;
    }, new Map<string, { stack_key: string; pass_runs: number; total_runs: number }>()),
  )
    .map(([, value]) => ({
      ...value,
      pass_rate: value.total_runs === 0 ? null : value.pass_runs / value.total_runs,
    }))
    .sort((left, right) => right.total_runs - left.total_runs);

  const mostCommonSkillBundles = Array.from(
    records.reduce((map, record) => {
      const bundleKey = record.telemetry.skill_ids.length > 0
        ? record.telemetry.skill_ids.join(' | ')
        : '(none)';
      map.set(bundleKey, (map.get(bundleKey) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  )
    .map(([skill_bundle, count]) => ({ skill_bundle, count }))
    .sort((left, right) => right.count - left.count);

  const summary = {
    generated_at: new Date().toISOString(),
    runs_scanned: runDirectories.length,
    v9_runs_with_telemetry: records.length,
    average_budget_by_domain: averageBudgetByDomain,
    highest_budget_stacks: highestBudgetStacks,
    warning_frequency: warningFrequency,
    qa_pass_rate_by_stack: qaPassRateByStack,
    most_common_skill_bundles: mostCommonSkillBundles,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();

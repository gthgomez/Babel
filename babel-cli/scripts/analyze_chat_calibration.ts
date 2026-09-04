/**
 * Offline post-calibration checkpoint.
 *
 * Reads only a frozen campaign manifest and per-cell JSON reports. Missing or
 * malformed evidence stays UNKNOWN; this command never calls a provider and
 * never invents paired model results.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildChatCalibrationSchedule,
  CHAT_CALIBRATION_MANIFEST_FILENAME,
  evaluateChatCalibrationReadiness,
  validateChatCalibrationManifest,
  type ChatCalibrationCell,
  type ChatCalibrationCellEvidence,
  type ChatCalibrationManifest,
} from '../src/services/chatCalibration.js';
import type { CausalRunWhyReport } from '../src/services/causalAttribution.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function json(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    return record(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function outcome(trial: JsonRecord | null): 'success' | 'failure' | 'blocked' | 'unknown' {
  if (!trial) return 'unknown';
  if (trial['honest_block'] === true) return 'blocked';
  const status = string(trial['status']);
  if (status === 'BLOCKED') return 'blocked';
  const causalReport = record(trial['causal_attribution']);
  const family = string(record(causalReport?.['attribution'])?.['family']);
  if (family && ['provider', 'harness', 'environment', 'budget', 'verifier', 'task'].includes(family)) return 'failure';
  if (status && !['ANSWER_READY', 'FIX_COMPLETE', 'COMPLETE'].includes(status)) return 'failure';
  if (trial['contract_success'] === true && (!status || ['ANSWER_READY', 'FIX_COMPLETE', 'COMPLETE'].includes(status))) return 'success';
  if (
    trial['hidden_ok'] === false ||
    trial['false_complete'] === true ||
    trial['contract_success'] === false
  ) return 'failure';
  return 'unknown';
}

function causal(trial: JsonRecord | null): CausalRunWhyReport | null {
  const value = record(trial?.['causal_attribution']);
  return value ? value as unknown as CausalRunWhyReport : null;
}

function routeKnown(session: JsonRecord | null, cell: ChatCalibrationCell): boolean {
  const routes = array(session?.['model_routes']).map(record).filter((value): value is JsonRecord => value !== null);
  const observed = new Map(
    array(session?.['observed_models'])
      .map(record)
      .filter((value): value is JsonRecord => value !== null)
      .map((value) => [string(value['inference_id']), value] as const),
  );
  return routes.length > 0 && routes.every((route) => {
    const inferenceId = string(route['inference_id']);
    const observedModel = inferenceId ? observed.get(inferenceId) : undefined;
    return route['provider'] === cell.model.provider &&
      route['sent_model_id'] === cell.model.exact_model_id &&
      observedModel?.['observed_model_id'] === cell.model.exact_model_id;
  });
}

function cellEvidence(root: string, cell: ChatCalibrationCell): {
  evidence: ChatCalibrationCellEvidence;
  reportCell: JsonRecord;
} {
  const reportPath = join(root, 'cells', cell.cell_id, 'report.json');
  const report = json(reportPath);
  const trial = record(array(report?.['trials'])[0]);
  const causalReport = causal(trial);
  const evidencePath = string(trial?.['evidence_path']) ??
    join(root, 'cells', cell.cell_id, 'live', `${cell.task_id}-t1-cli.json`);
  const liveEvidence = json(resolve(evidencePath));
  const session = record(liveEvidence?.['session_evidence']);
  const telemetry = record(session?.['telemetry']);
  const productTelemetry = record(session?.['product_telemetry']);
  const inferenceCalls = array(telemetry?.['inference_calls']).map(record).filter((value): value is JsonRecord => value !== null);
  const contextKnown = inferenceCalls.length > 0 && inferenceCalls.every((call) => boolean(call['context_preservation']) !== null);
  const taskFeasible = causalReport && !causalReport.attribution.unknowns.includes('task_feasible') ? true : null;
  const reportCell: JsonRecord = {
    cell_id: cell.cell_id,
    task_id: cell.task_id,
    trial: cell.trial,
    model: cell.model.exact_model_id,
    provider: cell.model.provider,
    outcome: outcome(trial),
    causal_attribution: causalReport,
    tokens: typeof trial?.['tokens'] === 'number' ? trial['tokens'] : null,
    cost_usd: typeof trial?.['cost_usd'] === 'number' ? trial['cost_usd'] : null,
    wall_ms: typeof trial?.['wall_ms'] === 'number' ? trial['wall_ms'] : null,
    writes: typeof telemetry?.['workspace'] === 'object' ? telemetry['workspace'] : null,
    verification: typeof telemetry?.['verification'] === 'object' ? telemetry['verification'] : null,
    harness_friction: typeof telemetry?.['harness_friction'] === 'object' ? telemetry['harness_friction'] : null,
    efficiency: productTelemetry?.['turn_telemetry'] ?? null,
    tool_calls: productTelemetry?.['tool_calls'] ?? null,
    policy_events: productTelemetry?.['policy_events'] ?? null,
    turn_routing: productTelemetry?.['turn_routing'] ?? null,
    turn_summaries: productTelemetry?.['turn_summaries'] ?? null,
    blocked_attempts: productTelemetry?.['blocked_attempts'] ?? null,
    blocked_attempt_counts: productTelemetry?.['blocked_attempt_counts'] ?? null,
  };
  const routeMismatch = !routeKnown(session, cell);
  const runtimeCrash = causalReport === null && array(trial?.['notes']).some((note) =>
    typeof note === 'string' && /spawn|crash|EPERM/i.test(note),
  );
  return {
    evidence: {
      cell,
      completed: report !== null && trial !== null && trial['invalid_task'] !== true,
      outcome: outcome(trial),
      causal_attribution: causalReport,
      task_feasible: taskFeasible,
      capability_authorization_known: telemetry?.['capability_authorization_known'] === true,
      tool_terminal_known: telemetry?.['tool_terminal_known'] === true,
      result_delivery_known: telemetry?.['result_delivery_known'] === true,
      verification_revision_known: telemetry?.['verification_revision_known'] === true,
      context_preservation_known: contextKnown,
      upstream_provider: string(liveEvidence?.['upstream_provider']),
      silent_model_substitution: routeMismatch && causalReport?.attribution.code === 'wrong_model_route',
      unclassified_runtime_crash: runtimeCrash,
    },
    reportCell,
  };
}

function write(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function refreshEvidenceManifest(root: string): string {
  const manifestName = 'calibration-evidence-manifest.json';
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const fullPath = join(directory, name);
      if (fullPath === join(root, manifestName)) continue;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) visit(fullPath);
      else if (stat.isFile()) {
        const bytes = readFileSync(fullPath);
        files.push({
          path: fullPath.slice(root.length + 1).replaceAll('\\', '/'),
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  };
  visit(root);
  const path = join(root, manifestName);
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, kind: 'babel_calibration_evidence_manifest', files }, null, 2)}\n`, 'utf8');
  return path;
}

function parseArgs(argv: string[]): { root: string; help: boolean } {
  let root = '';
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--evidence-dir') root = resolve(argv[++index] ?? '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { root, help };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: npx tsx scripts/analyze_chat_calibration.ts --evidence-dir <campaign-dir>\n');
    return;
  }
  if (!args.root) throw new Error('--evidence-dir is required');
  const canonicalManifestPath = join(args.root, CHAT_CALIBRATION_MANIFEST_FILENAME);
  const versionedManifestPath = join(args.root, 'chat-calibration-v1.manifest.json');
  const manifestPath = existsSync(canonicalManifestPath) ? canonicalManifestPath : versionedManifestPath;
  const manifest = json(manifestPath) as unknown as ChatCalibrationManifest | null;
  if (!manifest) throw new Error(`calibration manifest is missing or invalid: ${manifestPath}`);
  validateChatCalibrationManifest(manifest);

  const scheduled = new Map(buildChatCalibrationSchedule(manifest.schedule_seed).map((cell) => [cell.cell_id, cell]));
  const cells: ChatCalibrationCellEvidence[] = [];
  const reportCells: JsonRecord[] = [];
  for (const scheduledCell of manifest.schedule) {
    const cell = scheduled.get(scheduledCell.cell_id);
    if (!cell) throw new Error(`manifest schedule cell is not recognized: ${scheduledCell.cell_id}`);
    const result = cellEvidence(args.root, cell);
    cells.push(result.evidence);
    reportCells.push(result.reportCell);
  }
  const readiness = evaluateChatCalibrationReadiness(cells, manifest.campaign_id);
  const counts: Record<string, number> = {};
  for (const cell of reportCells) {
    const family = record(cell['causal_attribution'])?.['attribution'];
    const name = string(record(family)?.['family']) ?? 'unknown';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const models = ['glm', 'deepseek'].map((label) => {
    const selected = reportCells.filter((cell) => cell['model'] === manifest.model_ids[label === 'glm' ? 0 : 1]);
    const numeric = (key: string): number[] => selected.map((cell) => cell[key]).filter((value): value is number => typeof value === 'number');
    const tokens = numeric('tokens');
    const wall = numeric('wall_ms');
    const costs = numeric('cost_usd');
    return {
      label,
      exact_model_id: manifest.model_ids[label === 'glm' ? 0 : 1],
      cells: selected.length,
      successes: selected.filter((cell) => cell['outcome'] === 'success').length,
      failures: selected.filter((cell) => cell['outcome'] === 'failure').length,
      blocked: selected.filter((cell) => cell['outcome'] === 'blocked').length,
      unknown: selected.filter((cell) => cell['outcome'] === 'unknown').length,
      mean_tokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null,
      mean_wall_ms: wall.length ? wall.reduce((a, b) => a + b, 0) / wall.length : null,
      mean_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
    };
  });
  const familyCells = Object.entries(counts).map(([family, count]) => ({
    family,
    count,
    evidence_cells: reportCells
      .filter((cell) => string(record(record(cell['causal_attribution'])?.['attribution'])?.['family']) === family)
      .map((cell) => cell['cell_id']),
  }));
  const reports = [
    write(args.root, 'chat-calibration-report.json', {
      schema_version: 1,
      kind: 'babel_chat_calibration_report',
      status: readiness.status === 'ready' ? 'CALIBRATION_COMPLETE' : 'CALIBRATION_INCOMPLETE',
      campaign_id: manifest.campaign_id,
      manifest_sha256: sha256File(manifestPath),
      planned_cells: manifest.schedule.length,
      readiness,
      cells: reportCells,
      note: 'Offline checkpoint only; no model comparison is promoted unless readiness is ready.',
    }),
    write(args.root, 'model-comparison.json', {
      schema_version: 1,
      kind: 'babel_model_comparison',
      status: readiness.status === 'ready' ? 'INTERPRETABLE' : 'BLOCKED_BY_CALIBRATION_READINESS',
      models,
      model_behavior: familyCells.filter((entry) => entry.family === 'model'),
      babel_behavior: familyCells.filter((entry) => entry.family === 'harness'),
      provider_behavior: familyCells.filter((entry) => entry.family === 'provider'),
      environment_behavior: familyCells.filter((entry) => entry.family === 'environment'),
      unknown: familyCells.filter((entry) => entry.family === 'unknown'),
    }),
    write(args.root, 'babel-improvement-ledger.json', {
      schema_version: 1,
      kind: 'babel_improvement_ledger',
      status: readiness.status === 'ready' ? 'DERIVED_FROM_CALIBRATION' : 'CALIBRATION_INCOMPLETE',
      recommendations: familyCells
        .filter((entry) => entry.family === 'harness' || entry.family === 'unknown')
        .sort((a, b) => b.count - a.count)
        .map((entry, index) => ({
          rank: index + 1,
          finding_id: entry.family === 'unknown' ? 'OBS-UNKNOWN-001' : 'HARNESS-CAUSAL-001',
          family: entry.family,
          evidence_cells: entry.evidence_cells,
          recommendation: entry.family === 'unknown'
            ? 'Close the missing causal prerequisite before broad execution.'
            : 'Reproduce and fix the recurring harness boundary before broad execution.',
        })),
      note: 'Recommendations are generated only from observed cell evidence; no absent run is treated as a model result.',
    }),
    write(args.root, 'calibration-readiness.json', readiness),
  ];
  const evidenceManifest = refreshEvidenceManifest(args.root);
  process.stdout.write(`${JSON.stringify({ manifest: manifestPath, reports, evidence_manifest: evidenceManifest, readiness }, null, 2)}\n`);
}

main();

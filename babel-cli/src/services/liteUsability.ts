import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';
import { rewriteArgv } from '../cli/argv.js';
import { classifyDoTask } from '../commands/workflowCommands.js';

export type LiteUsabilityStatus = 'pass' | 'fail';

export interface LiteUsabilityFixture {
  id: string;
  user_goal: string;
  lite_command: string[];
  full_command: string[];
  expected_route: 'daily' | 'plan' | 'undo';
  expected_verb: 'ask' | 'plan' | 'patch' | 'propose' | 'diff' | 'fix' | 'review' | 'undo' | 'do';
  mutation_policy: 'read_only' | 'plan_only' | 'may_edit';
  expected_output_contract: string[];
}

export interface LiteUsabilityScenarioResult extends LiteUsabilityFixture {
  status: LiteUsabilityStatus;
  rewritten_lite_argv: string[];
  checks: Array<{
    name: string;
    status: LiteUsabilityStatus;
    detail: string;
  }>;
  comparison: {
    lite_token_count: number;
    full_token_count: number;
    shorter_than_full: boolean;
  };
}

export interface LiteUsabilityReport {
  benchmark_type: 'babel_lite_usability';
  generated_at: string;
  artifact_path: string;
  summary: {
    scenarios: number;
    pass: number;
    fail: number;
  };
  scenarios: LiteUsabilityScenarioResult[];
}

function defaultFixturePath(): string {
  return join(BABEL_ROOT, 'babel-cli', 'src', 'fixtures', 'lite-usability', 'scenarios.json');
}

function defaultOutputPath(outputDir?: string): string {
  const dir = resolve(outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'));
  mkdirSync(dir, { recursive: true });
  return join(dir, `babel-lite-usability-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

function readFixtures(fixturePath?: string): LiteUsabilityFixture[] {
  const raw = readFileSync(resolve(fixturePath ?? defaultFixturePath()), 'utf8');
  const parsed = JSON.parse(raw) as { scenarios?: LiteUsabilityFixture[] };
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error('Lite usability fixture must contain a scenarios array.');
  }
  return parsed.scenarios;
}

function commandToArgv(command: string[]): string[] {
  const executable = command[0] ?? 'babel';
  return ['node', executable, ...command.slice(1)];
}

function tokenCount(command: string[]): number {
  return command.join(' ').split(/\s+/).filter(Boolean).length;
}

function taskTextFromRewrittenArgv(rewritten: string[]): string {
  const route = rewritten[2];
  if (route === 'daily' || route === 'plan') {
    return rewritten
      .slice(3)
      .filter((token) => !token.startsWith('-'))
      .join(' ');
  }
  return '';
}

function inferredSessionVerb(route: string, taskText: string): string {
  if (route === 'plan') {
    return 'plan';
  }
  if (route === 'undo') {
    return 'undo';
  }
  if (route === 'daily') {
    return classifyDoTask(taskText);
  }
  return route;
}

function evaluateFixture(fixture: LiteUsabilityFixture): LiteUsabilityScenarioResult {
  const rewritten = rewriteArgv(commandToArgv(fixture.lite_command));
  const checks: LiteUsabilityScenarioResult['checks'] = [];
  const route = rewritten[2] ?? '';

  const routeOk = route === fixture.expected_route;
  checks.push({
    name: 'routes_to_session_lane',
    status: routeOk ? 'pass' : 'fail',
    detail: routeOk
      ? `Command routes to ${fixture.expected_route}.`
      : `Expected ${fixture.expected_route} at argv[2], got ${String(route)}.`,
  });

  const taskText = taskTextFromRewrittenArgv(rewritten);
  const inferredVerb = inferredSessionVerb(route, taskText);
  const verbOk = inferredVerb === fixture.expected_verb;
  checks.push({
    name: 'preserves_user_intent',
    status: verbOk ? 'pass' : 'fail',
    detail: verbOk
      ? `Intent is ${fixture.expected_verb}.`
      : `Expected ${fixture.expected_verb}, got ${String(inferredVerb)}.`,
  });

  const taskOk =
    fixture.expected_verb === 'undo' ||
    fixture.expected_route === 'plan' ||
    taskText.includes(fixture.user_goal);
  checks.push({
    name: 'preserves_natural_task_text',
    status: taskOk ? 'pass' : 'fail',
    detail: taskOk ? 'Natural task text is preserved.' : `Task text was not preserved: ${taskText}`,
  });

  const outputContractOk =
    fixture.expected_output_contract.length >= 2 &&
    fixture.expected_output_contract.includes('status');
  checks.push({
    name: 'has_user_output_contract',
    status: outputContractOk ? 'pass' : 'fail',
    detail: outputContractOk
      ? 'Fixture declares a minimum user-facing output contract.'
      : 'Output contract is too thin.',
  });

  const liteTokens = tokenCount(fixture.lite_command);
  const fullTokens = tokenCount(fixture.full_command);
  const shorter = liteTokens < fullTokens;
  checks.push({
    name: 'shorter_than_full_babel',
    status: shorter ? 'pass' : 'fail',
    detail: `${liteTokens} daily tokens vs ${fullTokens} full Babel tokens.`,
  });

  return {
    ...fixture,
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    rewritten_lite_argv: rewritten,
    checks,
    comparison: {
      lite_token_count: liteTokens,
      full_token_count: fullTokens,
      shorter_than_full: shorter,
    },
  };
}

export function buildLiteUsabilityReport(
  options: {
    fixturePath?: string;
    outputDir?: string;
  } = {},
): LiteUsabilityReport {
  const scenarios = readFixtures(options.fixturePath).map(evaluateFixture);
  const artifactPath = defaultOutputPath(options.outputDir);
  const report: LiteUsabilityReport = {
    benchmark_type: 'babel_lite_usability',
    generated_at: new Date().toISOString(),
    artifact_path: artifactPath,
    summary: {
      scenarios: scenarios.length,
      pass: scenarios.filter((scenario) => scenario.status === 'pass').length,
      fail: scenarios.filter((scenario) => scenario.status === 'fail').length,
    },
    scenarios,
  };
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatLiteUsabilityReportHuman(report: LiteUsabilityReport): string {
  const lines = [
    'Babel Lite Usability Benchmark',
    `Artifact: ${report.artifact_path}`,
    `Scenarios: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.scenarios} total`,
    '',
  ];
  for (const scenario of report.scenarios) {
    lines.push(`${scenario.status.toUpperCase().padEnd(5)} ${scenario.id}`);
    lines.push(`  daily: ${scenario.lite_command.join(' ')}`);
    lines.push(`  full: ${scenario.full_command.join(' ')}`);
  }
  return lines.join('\n');
}

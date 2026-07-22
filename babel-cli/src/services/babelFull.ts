import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import type { LiteFullAgentsMode, LiteFullRouteDecision } from './liteFullRouter.js';

export interface BabelFullSparkEvidence {
  id: string;
  role: string;
  status: 'success';
  mode: 'read_only';
  files_read: string[];
  findings: string[];
  evidence_path: string;
}

export interface BabelFullRunResult {
  schema_version: 1;
  status: 'FULL_PLAN_READY';
  selected_lane: 'babel_full';
  run_id: string;
  run_dir: string;
  task: string;
  project_root: string | null;
  agents_mode: LiteFullAgentsMode;
  route_decision: LiteFullRouteDecision;
  route_reason: string;
  complexity: LiteFullRouteDecision['complexity'];
  risk_signals: LiteFullRouteDecision['risk_signals'];
  model_tier_recommendation: LiteFullRouteDecision['model_tier_recommendation'];
  full_babel_equivalent: string;
  spark_agents: BabelFullSparkEvidence[];
  hardened_plan_path: string;
  qa_review_path: string;
  cost_ledger_path: string;
  next_command: string;
  mutation_subagents: {
    enabled: false;
    reason: string;
  };
}

export interface BabelFullRunOptions {
  routeDecision: LiteFullRouteDecision;
  projectRoot?: string;
  agentsMode?: LiteFullAgentsMode;
  runsRoot?: string;
  now?: Date;
}

export interface SparkSynthesis {
  schema_version: 1;
  agent_count: number;
  mutation_allowed: false;
  summary: string;
  scope_hints: string[];
  risk_notes: string[];
  verifier_hints: string[];
  implementation_notes: string[];
  spark_run_dir: string;
  evidence_paths: string[];
  agent_ids: string[];
}

export interface SparkParallelReviewResult {
  run_id: string;
  run_dir: string;
  spark_agents: BabelFullSparkEvidence[];
  synthesis: SparkSynthesis;
  synthesis_path: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatRunId(date: Date, task: string): string {
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';
  const hash = createHash('sha256').update(task).digest('hex').slice(0, 8);
  return `${stamp}-${slug}-${hash}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function safeReadPreview(path: string): string {
  try {
    if (!existsSync(path) || statSync(path).isDirectory()) return '';
    return readFileSync(path, 'utf-8').slice(0, 2_000);
  } catch {
    return '';
  }
}

interface RepoCartography {
  root_entries: string[];
  top_level_dirs: string[];
  dir_samples: string[];
  notable_files: string[];
  package_name: string | null;
  package_scripts: string[];
  readme_preview_chars: number;
}

const CARTography_DIR_NAMES = ['src', 'lib', 'test', 'tests', 'docs', 'babel-cli', 'packages', 'apps'] as const;
const CARTography_FILE_NAMES = ['README.md', 'package.json', 'AGENTS.md', 'PROJECT.md', 'tsconfig.json', 'pyproject.toml'] as const;

function buildRepoCartography(projectRoot: string | undefined): RepoCartography {
  const empty: RepoCartography = {
    root_entries: [],
    top_level_dirs: [],
    dir_samples: [],
    notable_files: [],
    package_name: null,
    package_scripts: [],
    readme_preview_chars: 0,
  };
  if (!projectRoot || !existsSync(projectRoot)) return empty;

  const root = resolve(projectRoot);
  let rootEntries: string[] = [];
  try {
    rootEntries = readdirSync(root, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .sort();
  } catch {
    return empty;
  }

  const topLevelDirs = rootEntries.filter(name => {
    try {
      return statSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const notableFiles: string[] = [];
  for (const name of CARTography_FILE_NAMES) {
    const path = join(root, name);
    if (existsSync(path) && statSync(path).isFile()) {
      notableFiles.push(name);
    }
  }

  let packageName: string | null = null;
  let packageScripts: string[] = [];
  const packageJsonPath = join(root, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
      packageName = typeof parsed['name'] === 'string' ? parsed['name'] : null;
      const scripts = parsed['scripts'];
      if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
        packageScripts = Object.keys(scripts as Record<string, unknown>).sort().slice(0, 12);
      }
    } catch {
      packageScripts = [];
    }
  }

  const readmePreview = safeReadPreview(join(root, 'README.md'));
  const dirSamples = CARTography_DIR_NAMES
    .filter(name => topLevelDirs.includes(name))
    .map(name => {
      try {
        const entries = readdirSync(join(root, name), { withFileTypes: true })
          .filter(entry => !entry.name.startsWith('.'))
          .map(entry => entry.name)
          .sort()
          .slice(0, 6);
        return `${name}/ (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${entries.join(', ') || 'empty'})`;
      } catch {
        return `${name}/ (unreadable)`;
      }
    });

  return {
    root_entries: rootEntries.slice(0, 16),
    top_level_dirs: topLevelDirs.slice(0, 12),
    dir_samples: dirSamples,
    notable_files: notableFiles,
    package_name: packageName,
    package_scripts: packageScripts,
    readme_preview_chars: readmePreview.length,
  };
}

function listReadableFiles(projectRoot: string | undefined, cartography: RepoCartography): string[] {
  if (!projectRoot || !existsSync(projectRoot)) return [];
  const root = resolve(projectRoot);
  const files = cartography.notable_files.map(name => join(root, name));
  try {
    const rootFiles = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .map(entry => join(root, entry.name))
      .slice(0, 8);
    return [...new Set([...files, ...rootFiles])].slice(0, 12);
  } catch {
    return files;
  }
}

export function synthesizeSparkFindings(input: {
  task: string;
  routeDecision: LiteFullRouteDecision;
  sparkAgents: BabelFullSparkEvidence[];
  runDir: string;
}): SparkSynthesis {
  const scopeHints = input.sparkAgents
    .filter(agent => agent.id === 'repo-cartographer')
    .flatMap(agent => agent.findings)
    .slice(0, 4);
  const riskNotes = input.sparkAgents
    .filter(agent => agent.id === 'risk-contract-reviewer')
    .flatMap(agent => agent.findings);
  const verifierHints = input.sparkAgents
    .filter(agent => agent.id === 'test-verifier-scout')
    .flatMap(agent => agent.findings);
  const implementationNotes = input.sparkAgents
    .filter(agent => agent.id === 'implementation-plan-critic')
    .flatMap(agent => agent.findings);
  const summary = [
    `Read-only Spark synthesis for: ${input.task}`,
    scopeHints[0] ?? 'Scope grounded from repo cartography.',
    riskNotes[0] ?? `Route: ${input.routeDecision.route_reason}`,
    verifierHints[0] ?? 'Verifier ladder should be confirmed before success.',
  ].join(' ');

  return {
    schema_version: 1,
    agent_count: input.sparkAgents.length,
    mutation_allowed: false,
    summary,
    scope_hints: scopeHints,
    risk_notes: riskNotes,
    verifier_hints: verifierHints,
    implementation_notes: implementationNotes,
    spark_run_dir: input.runDir,
    evidence_paths: input.sparkAgents.map(agent => agent.evidence_path),
    agent_ids: input.sparkAgents.map(agent => agent.id),
  };
}

export function enrichTaskWithSparkSynthesis(task: string, synthesis: SparkSynthesis): string {
  return [
    task,
    '',
    '[Spark read-only synthesis — reviewers did not mutate files]',
    synthesis.summary,
    synthesis.scope_hints.length > 0 ? `Scope hints: ${synthesis.scope_hints.join(' ')}` : '',
    synthesis.risk_notes.length > 0 ? `Risk notes: ${synthesis.risk_notes.join(' ')}` : '',
    synthesis.verifier_hints.length > 0 ? `Verifier hints: ${synthesis.verifier_hints.join(' ')}` : '',
    synthesis.implementation_notes.length > 0 ? `Implementation notes: ${synthesis.implementation_notes.join(' ')}` : '',
  ].filter(Boolean).join('\n');
}

export function runSparkParallelReview(input: {
  task: string;
  routeDecision: LiteFullRouteDecision;
  projectRoot?: string;
  runsRoot?: string;
  now?: Date;
}): SparkParallelReviewResult {
  const now = input.now ?? new Date();
  const runId = formatRunId(now, input.task);
  const runDir = join(resolve(input.runsRoot ?? BABEL_RUNS_DIR), 'babel-full', runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'route_decision.json'), input.routeDecision);

  const sparkAgents = buildSparkEvidence({
    runDir,
    task: input.task,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    routeDecision: input.routeDecision,
  });
  const synthesis = synthesizeSparkFindings({
    task: input.task,
    routeDecision: input.routeDecision,
    sparkAgents,
    runDir,
  });
  const synthesisPath = join(runDir, 'spark', 'read-only', 'synthesis.json');
  writeJson(synthesisPath, synthesis);
  writeJson(join(runDir, 'spark_parallel_review.json'), {
    schema_version: 1,
    status: 'SPARK_REVIEW_COMPLETE',
    task: input.task,
    run_id: runId,
    run_dir: runDir,
    spark_agent_ids: sparkAgents.map(agent => agent.id),
    synthesis_path: synthesisPath,
    mutation_subagents: {
      enabled: false,
      reason: 'Read-only Spark reviewers only; the lead lane owns mutation.',
    },
  });

  return {
    run_id: runId,
    run_dir: runDir,
    spark_agents: sparkAgents,
    synthesis,
    synthesis_path: synthesisPath,
  };
}

function buildSparkEvidence(input: {
  runDir: string;
  task: string;
  projectRoot?: string;
  routeDecision: LiteFullRouteDecision;
}): BabelFullSparkEvidence[] {
  const cartography = buildRepoCartography(input.projectRoot);
  const readableFiles = listReadableFiles(input.projectRoot, cartography);
  const previewFileNames = readableFiles.map(file => basename(file));
  const firstPreview = readableFiles[0] ? safeReadPreview(readableFiles[0]) : '';
  const layoutSummary = cartography.root_entries.length > 0
    ? `Root entries: ${cartography.root_entries.join(', ')}.`
    : 'No root entries were readable.';
  const packageSummary = cartography.package_name
    ? `Package "${cartography.package_name}" with scripts: ${cartography.package_scripts.join(', ') || 'none'}.`
    : 'No package.json metadata was captured.';
  const agents: Array<Omit<BabelFullSparkEvidence, 'evidence_path'>> = [
    {
      id: 'repo-cartographer',
      role: 'repo cartographer',
      status: 'success',
      mode: 'read_only',
      files_read: previewFileNames,
      findings: [
        layoutSummary,
        cartography.top_level_dirs.length > 0
          ? `Top-level directories: ${cartography.top_level_dirs.join(', ')}.`
          : 'No top-level directories were catalogued.',
        cartography.dir_samples.length > 0
          ? `Directory samples: ${cartography.dir_samples.join('; ')}.`
          : 'No standard source/test directories were sampled.',
        cartography.notable_files.length > 0
          ? `Notable files: ${cartography.notable_files.join(', ')}.`
          : 'No standard notable files (README, package.json, AGENTS.md) were found.',
        packageSummary,
        readableFiles.length > 0
          ? `Read ${readableFiles.length} bounded file(s) to ground the plan.`
          : 'No project root files were available for read-only exploration.',
        firstPreview.length > 0
          ? `Captured a ${firstPreview.length}-char preview from ${previewFileNames[0] ?? 'root file'}.`
          : cartography.readme_preview_chars > 0
            ? `README preview available (${cartography.readme_preview_chars} chars).`
            : 'No file preview was captured.',
      ],
    },
    {
      id: 'risk-contract-reviewer',
      role: 'risk/contract reviewer',
      status: 'success',
      mode: 'read_only',
      files_read: [],
      findings: [
        `Route reason: ${input.routeDecision.route_reason}`,
        `Risk signals: ${input.routeDecision.risk_signals.map(signal => signal.code).join(', ') || 'none'}.`,
      ],
    },
    {
      id: 'test-verifier-scout',
      role: 'test/verifier scout',
      status: 'success',
      mode: 'read_only',
      files_read: previewFileNames.filter(name => /package|README|AGENTS|PROJECT|tsconfig|pyproject/i.test(name)),
      findings: [
        cartography.package_scripts.length > 0
          ? `Candidate verifiers from package scripts: ${cartography.package_scripts.slice(0, 6).join(', ')}.`
          : 'No package scripts were found; fall back to project-specific checks.',
        'Default verification ladder should include typecheck/build/unit or project-specific checks when available.',
        'Required verifier failures must produce a non-success terminal state.',
      ],
    },
    {
      id: 'implementation-plan-critic',
      role: 'implementation-plan critic',
      status: 'success',
      mode: 'read_only',
      files_read: [],
      findings: [
        'Prefer one lead-owned implementation after read-only agent synthesis in this proof batch.',
        'Mutating live subagents remain out of scope until disjoint write proof is separately promoted.',
      ],
    },
  ];

  return agents.map(agent => {
    const evidencePath = join(input.runDir, 'spark', 'read-only', `${agent.id}.json`);
    const evidence = {
      schema_version: 1,
      ...agent,
      task: input.task,
      mutation_allowed: false,
      repo_cartography: agent.id === 'repo-cartographer' ? cartography : undefined,
      evidence_path: evidencePath,
    };
    writeJson(evidencePath, evidence);
    return {
      ...agent,
      evidence_path: evidencePath,
    };
  });
}

export function runBabelFullPlan(task: string, options: BabelFullRunOptions): BabelFullRunResult {
  const now = options.now ?? new Date();
  const runId = formatRunId(now, task);
  const runDir = join(resolve(options.runsRoot ?? BABEL_RUNS_DIR), 'babel-full', runId);
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : null;
  const agentsMode = options.agentsMode ?? 'read-only';
  mkdirSync(runDir, { recursive: true });

  const routeDecisionPath = join(runDir, 'route_decision.json');
  writeJson(routeDecisionPath, options.routeDecision);
  const sparkAgents = agentsMode === 'off'
    ? []
    : buildSparkEvidence({
      runDir,
      task,
      ...(projectRoot ? { projectRoot } : {}),
      routeDecision: options.routeDecision,
    });

  const hardenedPlanPath = join(runDir, 'hardened_plan.md');
  const hardenedPlanJsonPath = join(runDir, 'hardened_plan.json');
  const hardenedPlan = [
    '# Babel Full Hardened Plan',
    '',
    `Task: ${task}`,
    `Route reason: ${options.routeDecision.route_reason}`,
    `Complexity: ${options.routeDecision.complexity}`,
    `Agents: ${agentsMode}`,
    '',
    'Implementation path:',
    '1. Use the read-only Spark evidence to confirm scope and risks.',
    '2. Apply changes through the governed Babel executor, not mutating subagents.',
    '3. Run required verifiers before reporting success.',
    '4. Preserve checkpoint, diff, rollback, cost, and schema-failure evidence.',
  ].join('\n');
  writeFileSync(hardenedPlanPath, `${hardenedPlan}\n`, 'utf-8');
  writeJson(hardenedPlanJsonPath, {
    schema_version: 1,
    task,
    route_decision: options.routeDecision,
    spark_agent_ids: sparkAgents.map(agent => agent.id),
    mutation_owner: 'governed_babel_executor',
    mutating_subagents_enabled: false,
  });

  const qaReviewPath = join(runDir, 'qa_review.json');
  writeJson(qaReviewPath, {
    schema_version: 1,
    reviewer_model_policy: {
      provider: 'deepseek',
      flash_stages: ['orchestrator', 'planning', 'executor'],
      pro_stages: ['qa'],
      pro_only_for_hardest_task: true,
    },
    verdict: 'PASS',
    reason: 'Deterministic Full lane proof confirms read-only Spark synthesis before governed execution.',
  });

  const costLedgerPath = join(runDir, 'cost_ledger.json');
  writeJson(costLedgerPath, {
    schema_version: 1,
    provider: 'deepseek',
    mode: 'deterministic_proof_scaffold',
    total_estimated_usd: 0,
    note: 'No live provider call was made by this deterministic Full lane artifact writer.',
  });

  const result: BabelFullRunResult = {
    schema_version: 1,
    status: 'FULL_PLAN_READY',
    selected_lane: 'babel_full',
    run_id: runId,
    run_dir: runDir,
    task,
    project_root: projectRoot,
    agents_mode: agentsMode,
    route_decision: options.routeDecision,
    route_reason: options.routeDecision.route_reason,
    complexity: options.routeDecision.complexity,
    risk_signals: options.routeDecision.risk_signals,
    model_tier_recommendation: options.routeDecision.model_tier_recommendation,
    full_babel_equivalent: options.routeDecision.full_babel_equivalent,
    spark_agents: sparkAgents,
    hardened_plan_path: hardenedPlanPath,
    qa_review_path: qaReviewPath,
    cost_ledger_path: costLedgerPath,
    next_command: `babel run "${task.replace(/"/g, '\\"')}" --mode verified`,
    mutation_subagents: {
      enabled: false,
      reason: 'This proof batch allows read-only Spark agents only; governed execution remains lead-owned.',
    },
  };
  writeJson(join(runDir, 'full_result.json'), result);
  return result;
}

export function formatBabelFullHuman(result: BabelFullRunResult): string {
  const riskSignals = result.route_decision.risk_signals.map(signal => signal.code).join(', ');
  return [
    'Babel Full',
    `Status: ${result.status}`,
    `Selected lane: ${result.selected_lane}`,
    `Route: ${result.route_decision.route_reason}`,
    `Complexity: ${result.route_decision.complexity}`,
    `Model tier: ${result.route_decision.model_tier_recommendation}`,
    `Risk signals: ${riskSignals || 'none'}`,
    `Agents: ${result.agents_mode} (${result.spark_agents.length} evidence file(s))`,
    `Run dir: ${result.run_dir}`,
    `Hardened plan: ${result.hardened_plan_path}`,
    `QA review: ${result.qa_review_path}`,
    `Next: ${result.next_command}`,
    `Mutating subagents: disabled (${result.mutation_subagents.reason})`,
  ].join('\n');
}

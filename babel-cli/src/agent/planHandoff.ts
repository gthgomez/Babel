import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { LiteTaskContract } from '../lite/contract.js';
import type { QaVerdict, SwePlan } from '../schemas/agentContracts.js';

export interface PlanHandoff {
  planRunId: string;
  planRunDir: string;
  contract: LiteTaskContract | null;
  modelPlan: Record<string, unknown> | null;
  allowedPaths: string[];
  contextText: string;
}

const PLAN_RUN_ID_RE = /\b(\d{8}T\d{6}Z-plan-[a-f0-9]+)\b/i;
const PLAN_RUN_DIR_RE = /runs[/\\]babel-lite[/\\](\d{8}T\d{6}Z-plan-[a-f0-9]+)/i;

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function extractPlanRunId(task: string): string | null {
  const direct = task.match(PLAN_RUN_ID_RE)?.[1] ?? null;
  if (direct) {
    return direct;
  }
  return task.match(PLAN_RUN_DIR_RE)?.[1] ?? null;
}

function findLatestPlanRunDir(repoPath: string): string | null {
  const liteRoot = join(resolve(repoPath), 'runs', 'babel-lite');
  if (!existsSync(liteRoot)) {
    return null;
  }
  const candidates = readdirSync(liteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /-plan-/.test(entry.name))
    .map((entry) => join(liteRoot, entry.name))
    .sort((left, right) => right.localeCompare(left));
  return candidates[0] ?? null;
}

function trimForPrompt(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}

function readHandoffFileSnippet(
  repoPath: string,
  relativePath: string,
  maxChars = 6000,
): string | null {
  const absolutePath = resolve(repoPath, relativePath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  try {
    return trimForPrompt(readFileSync(absolutePath, 'utf8'), maxChars);
  } catch {
    return null;
  }
}

export function resolvePlanRunDir(
  repoPath: string,
  task: string,
  explicitPlanRunId?: string,
): string | null {
  const planRunId = explicitPlanRunId ?? extractPlanRunId(task);
  if (planRunId) {
    const candidate = join(resolve(repoPath), 'runs', 'babel-lite', planRunId);
    return existsSync(candidate) ? candidate : null;
  }
  const lowerTask = task.toLowerCase();
  if (
    lowerTask.includes('plan') ||
    lowerTask.includes('apply') ||
    lowerTask.includes('patch') ||
    lowerTask.includes('propose')
  ) {
    return findLatestPlanRunDir(repoPath);
  }
  return null;
}

export function loadPlanHandoff(input: {
  repoPath: string;
  task: string;
  planRunId?: string;
}): PlanHandoff | null {
  const planRunDir = resolvePlanRunDir(input.repoPath, input.task, input.planRunId);
  if (!planRunDir) {
    return null;
  }
  const planRunId = planRunDir.split(/[/\\]/).pop() ?? planRunDir;
  const contractRaw = safeReadJson(join(planRunDir, 'contract.json'));
  const modelPlan = safeReadJson(join(planRunDir, 'model_plan.json'));
  const contract = contractRaw as LiteTaskContract | null;

  const allowedPaths = new Set<string>();
  for (const path of contract?.likely_files ?? []) {
    if (typeof path === 'string' && path.trim()) {
      allowedPaths.add(path.trim());
    }
  }
  for (const path of contract?.required_reads ?? []) {
    if (typeof path === 'string' && path.trim()) {
      allowedPaths.add(path.trim());
    }
  }
  if (Array.isArray(modelPlan?.['likely_files'])) {
    for (const path of modelPlan['likely_files']) {
      if (typeof path === 'string' && path.trim()) {
        allowedPaths.add(path.trim());
      }
    }
  }

  const snippets: string[] = [
    `# Approved Plan Handoff`,
    `plan_run_id: ${planRunId}`,
    `plan_run_dir: ${planRunDir}`,
  ];
  if (typeof modelPlan?.['summary'] === 'string') {
    snippets.push(`summary: ${modelPlan['summary']}`);
  }
  if (typeof modelPlan?.['answer'] === 'string') {
    snippets.push('', 'plan_answer:', modelPlan['answer']);
  }
  if (Array.isArray(modelPlan?.['steps'])) {
    snippets.push(
      '',
      'plan_steps:',
      ...modelPlan['steps'].map((step, index) => `${index + 1}. ${String(step)}`),
    );
  }

  snippets.push('', '# Required reads (from plan contract)');
  for (const relativePath of [...allowedPaths].slice(0, 12)) {
    const content = readHandoffFileSnippet(input.repoPath, relativePath);
    if (content === null) {
      snippets.push(`## ${relativePath}\n(missing on disk)`);
      continue;
    }
    snippets.push(`## ${relativePath}\n${content}`);
  }

  return {
    planRunId,
    planRunDir,
    contract,
    modelPlan,
    allowedPaths: [...allowedPaths],
    contextText: snippets.join('\n'),
  };
}

export function assertPlannerPathsAllowed(paths: string[], allowedPaths: string[]): string[] {
  if (allowedPaths.length === 0) {
    return [];
  }
  const allowed = new Set(allowedPaths.map((path) => path.replace(/\\/g, '/')));
  const violations: string[] = [];
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, '/');
    if (
      [...allowed].some(
        (candidate) => normalized === candidate || normalized.endsWith(`/${candidate}`),
      )
    ) {
      continue;
    }
    violations.push(rawPath);
  }
  return violations;
}

function extractPlanFileTargets(swePlan: SwePlan): string[] {
  const paths = new Set<string>();
  for (const step of swePlan.minimal_action_set) {
    const tool = String(step.tool ?? '').trim();
    if (typeof step.target !== 'string' || !step.target.trim()) {
      continue;
    }
    if (tool === 'file_read' || tool === 'file_write') {
      paths.add(step.target.trim());
    }
  }
  return [...paths];
}

export function collectPlanHandoffViolations(
  swePlan: SwePlan | null | undefined,
  allowedPaths: string[],
): string[] {
  if (!swePlan?.minimal_action_set?.length || allowedPaths.length === 0) {
    return [];
  }
  const referencedPaths = extractPlanFileTargets(swePlan);
  return assertPlannerPathsAllowed(referencedPaths, allowedPaths).map(
    (path) =>
      `[PLAN_HANDOFF_GUARD] Planner referenced path outside approved plan contract: ${path}`,
  );
}

export function buildPlanHandoffQaReject(violations: string[]): Partial<QaVerdict> {
  return {
    verdict: 'REJECT',
    failure_count: violations.length,
    overall_confidence: 5,
    failures: violations.map((condition) => ({
      tag: 'EVIDENCE-GATE',
      condition,
      confidence: 5,
      fix_hint:
        'Use only files named in the approved plan contract (likely_files and required_reads).',
    })),
    proposed_fix_strategy:
      'Regenerate the plan using only paths from the approved plan handoff contract.',
  };
}

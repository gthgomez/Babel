import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

import type { LiteTaskContract } from '../lite/contract.js';
import { resolvePlanArtifactRoot } from '../lite/artifacts.js';
import { isCredentialTargetPath } from '../authority/protectedPath.js';
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
const PLAN_RUN_NAME_RE = /^\d{8}T\d{6}Z-plan-[a-f0-9]+$/i;
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

function planRoots(repoPath: string): string[] {
  return [...new Set([resolvePlanArtifactRoot(), join(resolve(repoPath), 'runs', 'babel-lite')])];
}

function belongsToProject(runDir: string, repoPath: string): boolean {
  const metadata = safeReadJson(join(runDir, 'manifest.json')) ?? safeReadJson(join(runDir, 'request.json'));
  const owner = metadata?.['project_root'];
  if (typeof owner === 'string') {
    try {
      const normalized = (path: string) => {
        const physical = realpathSync(resolve(path));
        return process.platform === 'win32' ? physical.toLowerCase() : physical;
      };
      return normalized(owner) === normalized(repoPath);
    } catch { return false; }
  }
  // Older repo-local runs lack target metadata. Shared private runs must have it.
  return resolve(runDir, '..') === join(resolve(repoPath), 'runs', 'babel-lite');
}

function findLatestPlanRunDir(repoPath: string): string | null {
  const candidates = planRoots(repoPath).flatMap(root => !existsSync(root) ? [] :
    readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PLAN_RUN_NAME_RE.test(entry.name))
      .map(entry => join(root, entry.name))
      .filter(path => belongsToProject(path, repoPath) && safeReadJson(join(path, 'model_plan.json')) !== null));
  return candidates.sort((left, right) => basename(right).localeCompare(basename(left)))[0] ?? null;
}

function trimForPrompt(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}

/** Model-generated paths never grant permission to read outside the target. */
function scopedHandoffPath(repoPath: string, path: string): string | null {
  if (!path.trim() || path.includes(':') || isAbsolute(path) || win32.isAbsolute(path)) return null;
  const credential = (value: string) => isCredentialTargetPath(value) || /(?:^|[/\\])\.(?:codex|git)(?:[/\\]|$)/i.test(value);
  const inside = (root: string, target: string) => {
    const rel = relative(root, target);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  try {
    const root = realpathSync(repoPath);
    const absolute = resolve(root, path);
    if (!inside(root, absolute) || credential(path) || credential(absolute)) return null;
    let ancestor = absolute;
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
    const physicalAncestor = realpathSync(ancestor);
    const physical = resolve(physicalAncestor, relative(ancestor, absolute));
    return inside(root, physical) && !credential(physical) ? physical : null;
  } catch { return null; }
}

function readHandoffFileSnippet(
  repoPath: string,
  relativePath: string,
  maxChars = 6000,
): string | null {
  const absolutePath = scopedHandoffPath(repoPath, relativePath);
  if (!absolutePath || !existsSync(absolutePath)) {
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
    if (!PLAN_RUN_NAME_RE.test(planRunId)) return null;
    return planRoots(repoPath).map(root => join(root, planRunId))
      .find(path => existsSync(path) && belongsToProject(path, repoPath)) ?? null;
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
      if (scopedHandoffPath(input.repoPath, path.trim())) allowedPaths.add(path.trim());
    }
  }
  for (const path of contract?.required_reads ?? []) {
    if (typeof path === 'string' && path.trim()) {
      if (scopedHandoffPath(input.repoPath, path.trim())) allowedPaths.add(path.trim());
    }
  }
  if (Array.isArray(modelPlan?.['likely_files'])) {
    for (const path of modelPlan['likely_files']) {
      if (typeof path === 'string' && path.trim()) {
        if (scopedHandoffPath(input.repoPath, path.trim())) allowedPaths.add(path.trim());
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

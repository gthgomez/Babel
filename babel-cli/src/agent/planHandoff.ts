import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

import type { LiteTaskContract } from '../lite/contract.js';
import { resolvePlanArtifactRoot } from '../lite/artifacts.js';
import { isCredentialTargetPath } from '../authority/protectedPath.js';
import { loadEnterprisePolicy } from '../config/enterprisePolicy.js';
import { redactEvidenceValue, redactSecrets } from '../utils/redaction.js';
import type { QaVerdict, SwePlan } from '../schemas/agentContracts.js';
import { checkedFileBytes } from '../utils/checkedFileRead.js';
import { acquireEffectDirectoryAnchors, type EffectDirectoryAnchors } from '../executor/effectDirectoryAnchors.js';
import { createHash } from 'node:crypto';
export { checkedFileBytes as checkedPlanFileBytes } from '../utils/checkedFileRead.js';

export interface PlanHandoff {
  planRunId: string;
  planRunDir: string;
  contract: LiteTaskContract | null;
  modelPlan: Record<string, unknown> | null;
  allowedPaths: string[];
  contextText: string;
  /** Digest of captured Plan source artifacts, when loaded under directory guards. */
  sourceFingerprint?: string;
  /** Physical project identity captured by the guarded reader. */
  sourceProjectIdentity?: string;
  /** Complete Plan body only when explicitly requested by the local Plan presenter. */
  sourcePlanText?: string | null;
}

export const PLAN_APPLY_UNAVAILABLE_REASON = 'Plan application is temporarily unavailable until mutation and verifier effects are scoped; the Plan is retained.';

/** Temporary admission gate until Plan-bound mutation and verifier effects are scoped. */
export function assertPlanMutationQualified(): void {
  throw new Error(`UNSUPPORTED_OPERATION: ${PLAN_APPLY_UNAVAILABLE_REASON}`);
}

const PLAN_RUN_ID_RE = /\b(\d{8}T\d{6}Z-plan-[a-f0-9]+)\b/i;
const PLAN_RUN_NAME_RE = /^\d{8}T\d{6}Z-plan-[a-f0-9]+$/i;
const PLAN_RUN_DIR_RE = /runs[/\\]babel-lite[/\\](\d{8}T\d{6}Z-plan-[a-f0-9]+)/i;

function checkedRegularFileRead(path: string, validatePath: () => boolean): string | null {
  return checkedFileBytes(path, 1024 * 1024, validatePath)?.toString('utf8') ?? null;
}

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const parent = normalize(realpathSync(dirname(path)));
    const content = checkedRegularFileRead(path, () =>
      normalize(realpathSync(dirname(path))) === parent &&
      normalize(realpathSync(path)) === normalize(join(parent, basename(path))));
    if (content === null) return null;
    const parsed = JSON.parse(content);
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

function belongsToProject(runDir: string, repoPath: string, artifacts?: ReadonlyMap<string, Buffer | null>): boolean {
  // A lexical legacy path must not confer trust on a junction to another tree.
  try {
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    const parent = normalize(realpathSync(dirname(runDir)));
    const actual = normalize(realpathSync(runDir));
    if (actual !== normalize(join(parent, basename(runDir)))) return false;
    const legacyRoot = join(resolve(repoPath), 'runs', 'babel-lite');
    if (resolve(dirname(runDir)) === legacyRoot) {
      const project = normalize(realpathSync(repoPath));
      const rel = relative(project, parent);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    }
  } catch { return false; }
  const manifestPath = join(runDir, 'manifest.json');
  const requestPath = join(runDir, 'request.json');
  const manifest = artifacts ? parseSnapshotJson(artifacts.get('manifest.json')) : safeReadJson(manifestPath);
  const request = artifacts ? parseSnapshotJson(artifacts.get('request.json')) : safeReadJson(requestPath);
  const manifestExists = artifacts ? artifacts.get('manifest.json') !== null : existsSync(manifestPath);
  const requestExists = artifacts ? artifacts.get('request.json') !== null : existsSync(requestPath);
  if ((manifestExists && !manifest) || (requestExists && !request)) return false;
  if (manifest?.['status'] === 'UNVERIFIED_LOCAL_DRAFT') return false;
  const owners = [manifest, request].filter((metadata): metadata is Record<string, unknown> =>
    metadata !== null && Object.hasOwn(metadata, 'project_root')).map(metadata => metadata['project_root']);
  if (owners.length > 0) {
    if (owners.some(owner => typeof owner !== 'string' || !owner.trim())) return false;
    try {
      const normalized = (path: string) => {
        const physical = realpathSync(resolve(path));
        return process.platform === 'win32' ? physical.toLowerCase() : physical;
      };
      const project = normalized(repoPath);
      return owners.every(owner => normalized(owner as string) === project);
    } catch { return false; }
  }
  // Older repo-local runs lack target metadata. Shared private runs must have it.
  return resolve(runDir, '..') === join(resolve(repoPath), 'runs', 'babel-lite');
}

function parseSnapshotJson(bytes: Buffer | null | undefined): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
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
export function scopedHandoffPath(repoPath: string, path: string): string | null {
  if (!path.trim() || path.includes(':') || isAbsolute(path) || win32.isAbsolute(path)) return null;
  const credential = (value: string) => isCredentialTargetPath(value) || /(?:^|[/\\])\.env(?:\.|$)/i.test(value) || /(?:^|[/\\])\.(?:codex|git)(?:[/\\]|$)/i.test(value);
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
  expectedPath?: string,
  anchors?: EffectDirectoryAnchors,
): string | null {
  const absolutePath = scopedHandoffPath(repoPath, relativePath);
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (expectedPath && (!absolutePath || normalize(absolutePath) !== normalize(expectedPath))) return null;
  if (!absolutePath || !existsSync(absolutePath)) {
    return null;
  }
  try {
    const accessPath = anchors ? anchors.path(absolutePath) : absolutePath;
    const content = checkedRegularFileRead(accessPath, () => {
      anchors?.path(absolutePath);
      const current = scopedHandoffPath(repoPath, relativePath);
      return current !== null && normalize(current) === normalize(absolutePath);
    });
    return content === null ? null : trimForPrompt(content, maxChars);
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
  // The synchronous reader validates file identity and physical path on every
  // read. Callers that need directory ownership to remain pinned across an
  // admission decision use loadPlanHandoffGuarded instead.
  return loadPlanHandoffUnqualified(input);
}

/** Shared Plan/source reader used by the synchronous and guarded entry points. */
function loadPlanHandoffUnqualified(input: {
  repoPath: string;
  task: string;
  planRunId?: string;
}, guarded?: { runDir: string; artifacts: ReadonlyMap<string, Buffer | null>; sources: ReadonlyMap<string, string>; sourceAnchors?: EffectDirectoryAnchors }): PlanHandoff | null {
  const planRunDir = guarded?.runDir ?? resolvePlanRunDir(input.repoPath, input.task, input.planRunId);
  if (!planRunDir) {
    return null;
  }
  const planRunId = planRunDir.split(/[/\\]/).pop() ?? planRunDir;
  const contractRaw = guarded ? parseSnapshotJson(guarded.artifacts.get('contract.json')) : safeReadJson(join(planRunDir, 'contract.json'));
  const modelPlan = guarded ? parseSnapshotJson(guarded.artifacts.get('model_plan.json')) : safeReadJson(join(planRunDir, 'model_plan.json'));
  const validPaths = (value: unknown) => value === undefined ||
    (Array.isArray(value) && value.length <= 1000 && value.every(item => typeof item === 'string' && item.length <= 4096));
  const validText = (value: unknown) => value === undefined || typeof value === 'string';
  const validSteps = (value: unknown) => value === undefined ||
    (Array.isArray(value) && value.length <= 1000 && value.every(item => typeof item === 'string' && item.length <= 32_000));
  if (!modelPlan || ((guarded ? guarded.artifacts.get('contract.json') !== null : existsSync(join(planRunDir, 'contract.json'))) && !contractRaw) ||
      (contractRaw && (contractRaw['schema_version'] !== 1 || contractRaw['mode'] !== 'babel-lite-plan' || !Array.isArray(contractRaw['likely_files']) || !Array.isArray(contractRaw['required_reads']))) ||
      !validPaths(contractRaw?.['likely_files']) || !validPaths(contractRaw?.['required_reads']) ||
      !validPaths(modelPlan['likely_files']) || !validText(modelPlan['summary']) || !validText(modelPlan['answer']) ||
      !validSteps(modelPlan['steps']) || (modelPlan['schema_version'] !== undefined && modelPlan['schema_version'] !== 1) ||
      (modelPlan['status'] !== undefined && modelPlan['status'] !== 'PLAN_READY')) return null;
  // Preserve the source artifact, but never silently send recognizable credentials
  // from legacy or model-written Plan metadata to another provider.
  const policy = loadEnterprisePolicy().policy;
  const safetyPolicy = { ...policy, redaction: { ...policy.redaction, enabled: true } };
  // Model-written text must not carry recognizable credentials. Contract path
  // identifiers are not secret material; their contents are guarded separately
  // by scoped reads and the context redaction below.
  if (JSON.stringify(redactEvidenceValue(modelPlan, safetyPolicy)) !== JSON.stringify(modelPlan)) return null;
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
  const snippets: string[] = [
    `# Approved Plan Handoff`,
    `plan_run_id: ${planRunId}`,
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
    const expected = guarded?.sources.get(relativePath);
    const content = guarded && !expected ? null : readHandoffFileSnippet(input.repoPath, relativePath, 6000, expected, guarded?.sourceAnchors);
    if (content === null) {
      snippets.push(`## ${relativePath}\n(missing on disk)`);
      continue;
    }
    snippets.push(`## ${relativePath}\n${content}`);
  }

  const contextText = trimForPrompt(snippets.join('\n'), 32_000);
  if (redactSecrets(contextText, safetyPolicy) !== contextText) return null;
  return {
    planRunId,
    planRunDir,
    contract,
    modelPlan,
    allowedPaths: [...allowedPaths],
    contextText,
  };
}

/** Guarded candidate for explicit Plan IDs; production callers remain contained until qualified. */
export async function loadPlanHandoffGuarded(input: {
  repoPath: string;
  task: string;
  planRunId?: string;
  signal?: AbortSignal;
  includePlanText?: boolean;
}): Promise<PlanHandoff | null> {
  input.signal?.throwIfAborted();
  const planRunId = input.planRunId ?? extractPlanRunId(input.task);
  if (!planRunId || !PLAN_RUN_NAME_RE.test(planRunId)) return null;
  const project = realpathSync(resolve(input.repoPath));
  const runs = planRoots(project).map(root => join(root, planRunId)).filter(path => existsSync(path));
  if (!runs.length) return null;
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const guarded = [...new Set([project, ...runs])];
  const expected = new Map(guarded.map(path => [path, lstatSync(path, { bigint: true })]));
  for (const path of guarded) {
    const stat = expected.get(path)!;
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(realpathSync(path)) !== normalize(resolve(path))) return null;
  }
  const metadataAnchors = await acquireEffectDirectoryAnchors(guarded);
  try {
    input.signal?.throwIfAborted();
    for (const path of guarded) {
      const anchored = dirname(metadataAnchors.path(join(path, '__babel_plan_anchor__')));
      const actual = statSync(anchored, { bigint: true }); const before = expected.get(path)!;
      if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino || normalize(realpathSync(path)) !== normalize(resolve(path))) return null;
    }
    const snapshotArtifacts = (run: string): { digest: string; artifacts: Map<string, Buffer | null> } => {
      const hash = createHash('sha256');
      const artifacts = new Map<string, Buffer | null>();
      for (const name of ['manifest.json', 'request.json', 'contract.json', 'model_plan.json', 'plan.md', 'verification.json', 'plan_review.json', 'plan_review.md']) {
        const path = join(run, name);
        const accessPath = metadataAnchors.path(path);
        let exact: BigIntStats;
        try { exact = lstatSync(accessPath, { bigint: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { artifacts.set(name, null); hash.update(`${name}\0missing\0`); continue; }
          throw error;
        }
        const stat = lstatSync(accessPath);
        const bytes = checkedFileBytes(accessPath, 1024 * 1024, () => {
          metadataAnchors.path(path);
          return normalize(realpathSync(run)) === normalize(resolve(run)) &&
            normalize(realpathSync(path)) === normalize(resolve(path));
        }, stat, exact);
        if (!bytes) throw new Error('Unsafe Plan source artifact.');
        artifacts.set(name, bytes);
        hash.update(`${name}\0${bytes.length}\0`).update(bytes);
      }
      return { digest: hash.digest('hex'), artifacts };
    };
    let selectedRun: string | undefined;
    let initial: ReturnType<typeof snapshotArtifacts> | undefined;
    for (const run of runs) {
      const snapshot = snapshotArtifacts(run);
      if (belongsToProject(run, project, snapshot.artifacts)) { selectedRun = run; initial = snapshot; break; }
    }
    if (!selectedRun || !initial) return null;
    const selectedContract = parseSnapshotJson(initial.artifacts.get('contract.json'));
    const sourceParents = new Set<string>();
    const sourcePaths = new Map<string, string>();
    for (const key of ['likely_files', 'required_reads']) {
      const values = selectedContract?.[key];
      if (!Array.isArray(values) || values.length > 1000) continue;
      for (const value of values) {
        if (sourcePaths.size >= 12) break;
        if (typeof value !== 'string') continue;
        const logical = value.trim();
        const path = scopedHandoffPath(project, logical);
        if (path) {
          if (!existsSync(dirname(path))) return null;
          sourceParents.add(dirname(path));
          sourcePaths.set(logical, path);
        }
      }
    }
    const parents = [...sourceParents];
    const sourceExpected = new Map(parents.map(path => [path, lstatSync(path, { bigint: true })]));
    for (const parent of parents) {
      const before = sourceExpected.get(parent)!;
      if (!before.isDirectory() || before.isSymbolicLink() || normalize(realpathSync(parent)) !== normalize(resolve(parent))) return null;
    }
    const sourceAnchors = parents.length ? await acquireEffectDirectoryAnchors(parents) : undefined;
    try {
      input.signal?.throwIfAborted();
      for (const parent of parents) {
        const anchored = dirname(sourceAnchors!.path(join(parent, '__babel_plan_source_anchor__')));
        const actual = statSync(anchored, { bigint: true }); const before = sourceExpected.get(parent)!;
        if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino || normalize(realpathSync(parent)) !== normalize(resolve(parent))) return null;
      }
      const result = loadPlanHandoffUnqualified({ ...input, repoPath: project, planRunId }, { runDir: selectedRun, artifacts: initial.artifacts, sources: sourcePaths, ...(sourceAnchors ? { sourceAnchors } : {}) });
      await new Promise<void>(resolveYield => setImmediate(resolveYield));
      input.signal?.throwIfAborted();
      for (const path of guarded) metadataAnchors.path(join(path, '__babel_plan_anchor__'));
      for (const parent of parents) sourceAnchors!.path(join(parent, '__babel_plan_source_anchor__'));
      if (snapshotArtifacts(selectedRun).digest !== initial.digest) return null;
      const projectIdentity = expected.get(project)!;
      if (projectIdentity.ino <= 0n) return null;
      return result ? {
        ...result,
        sourceFingerprint: initial.digest,
        sourceProjectIdentity: createHash('sha256').update(`babel-snapshot-root-v1\0${projectIdentity.dev}\0${projectIdentity.ino}`).digest('hex'),
        ...(input.includePlanText ? { sourcePlanText: initial.artifacts.get('plan.md')?.toString('utf8') ?? null } : {}),
      } : null;
    } finally { await sourceAnchors?.release(); }
  } finally { await metadataAnchors.release(); }
}

export function assertPlannerPathsAllowed(paths: string[], allowedPaths: string[]): string[] {
  const allowed = new Set(allowedPaths.map((path) => path.replace(/\\/g, '/')));
  const violations: string[] = [];
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, '/');
    if (allowed.has(normalized)) {
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
  if (!swePlan?.minimal_action_set?.length) {
    return [];
  }
  const referencedPaths = extractPlanFileTargets(swePlan);
  const violations = assertPlannerPathsAllowed(referencedPaths, allowedPaths).map(
    (path) =>
      `[PLAN_HANDOFF_GUARD] Planner referenced path outside approved plan contract: ${path}`,
  );
  if (swePlan.minimal_action_set.some(step => step.tool === 'shell_exec')) {
    violations.push('[PLAN_HANDOFF_GUARD] Shell execution is unavailable for Plan-bound work until its effects can be scoped.');
  }
  return violations;
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
      fix_hint: condition.includes('Shell execution is unavailable')
        ? 'Use scoped file tools and the existing verifier path; shell execution cannot establish Plan scope.'
        : 'Use only files named in the approved plan contract (likely_files and required_reads).',
    })),
    proposed_fix_strategy:
      'Regenerate the plan using only paths from the approved plan handoff contract.',
  };
}

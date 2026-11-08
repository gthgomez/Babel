/** Explicit, project-bound plan handoffs; planning never grants execution authority. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { runGitCommand, runGitCommandBytes } from '../utils/gitExec.js'
import { z } from 'zod'
import { resolveRuntimeUserStateRoot } from '../config/runtimePaths.js'
import { readRuntimeMode } from '../config/runtimeMode.js'
import { isReadOnlyChat } from '../agent/chatReadOnly.js'
import { assertFiniteBudgetSupported } from '../config/laneBudget.js'
import { hasExplicitEditDenial } from '../config/chatTaskClass.js'
import { checkedPlanFileBytes, loadPlanHandoff, loadPlanHandoffGuarded } from '../agent/planHandoff.js'
import { acquireEffectDirectoryAnchors } from '../executor/effectDirectoryAnchors.js'
import { writeNewPlanWithDirectoryGuard } from './guardedPlanWriter.js'
import { loadEnterprisePolicy } from '../config/enterprisePolicy.js'
import { redactSecrets } from '../utils/redaction.js'

const planSchema = z.object({ schemaVersion: z.literal(1), id: z.string(), projectRoot: z.string(), task: z.string(), body: z.string().min(1).max(1024 * 1024),
  sourceRunId: z.string().regex(/^\d{8}T\d{6}Z-plan-[a-f0-9]+$/i).optional(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceProjectIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  attemptId: z.string().uuid().optional(), attemptStartedAt: z.string().datetime().optional(),
  attemptRunDir: z.string().min(1).max(4096).optional(), attemptOutcome: z.string().min(1).max(200).optional(),
  createdAt: z.string(), fingerprint: z.string(), state: z.enum(['ready', 'applying', 'applied', 'failed', 'unknown']) })
export type SavedPlan = z.infer<typeof planSchema>

function planPath(id: string, env: NodeJS.ProcessEnv): string {
  if (!/^plan_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid saved plan ID. Legacy manual plan paths use the legacy apply command contract.')
  const root = resolveRuntimeUserStateRoot(env)
  const plans = join(root, 'plans')
  if (existsSync(plans)) {
    const info = lstatSync(plans)
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
    if (!info.isDirectory() || info.isSymbolicLink() || normalize(realpathSync(plans)) !== normalize(join(realpathSync(root), 'plans'))) throw new Error('Unsafe saved plan directory.')
  }
  return join(plans, `${id}.json`)
}

function atomicPlanWrite(path: string, plan: SavedPlan): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(plan)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

/** Freshness uses names, commit identity and filesystem metadata, never credential file contents. */
function projectFingerprint(root: string, env: NodeJS.ProcessEnv): string {
  const hash = createHash('sha256').update(root)
  const git = runGitCommandBytes(['ls-files', '--cached', '-z'], root, { env, timeoutMs: 10000, maxBuffer: 16 * 1024 * 1024 })
  let paths: string[]
  if (git.status === 0) {
    const untracked = runGitCommandBytes(['ls-files', '--others', '--exclude-standard', '-z'], root, { env, timeoutMs: 10000, maxBuffer: 16 * 1024 * 1024 })
    if (untracked.status !== 0) throw new Error('Could not inspect untracked project files for plan freshness.')
    // Generated repository-local Plan artifacts are not project changes. Only
    // known untracked artifact names are omitted; tracked paths and other
    // untracked files, including files beside a Plan, remain in the fingerprint.
    const artifact = /^runs\/babel-lite\/\d{8}[Tt]\d{6}[Zz]-plan-[a-fA-F0-9]+\/(?:manifest\.json|request\.json|contract\.json|prompt\.md|provider\.json|plan\.md|response\.md|model_plan\.json|verification\.json|spark_synthesis\.json|plan_review\.json|plan_review\.md|lite_schema_normalization\.json|error\.json|plan_session_loop\.json|00_ctx_lite_plan\.md|lite_plan_answer\.json|04_execution_report\.json|05_waterfall_telemetry\.json|cost_ledger\.json|plan_review_error\.txt)$/
    const isPlanArtifact = (path: string) => artifact.test(process.platform === 'win32' ? path.toLowerCase() : path)
    paths = [...new Set([...git.stdout.toString('utf8').split('\0').filter(Boolean), ...untracked.stdout.toString('utf8').split('\0').filter(path => path && !isPlanArtifact(path))])]
    const head = runGitCommand(['rev-parse', 'HEAD'], root, { env, timeoutMs: 3000 })
    hash.update(head.status === 0 ? head.stdout.trim() : 'unborn')
  } else {
    paths = []
    const omitted = new Set(['.git', 'node_modules', 'dist', 'runs', 'artifacts'])
    const privateState = resolveRuntimeUserStateRoot(env)
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (path === privateState || omitted.has(entry.name)) continue
        if (entry.isDirectory()) visit(path)
        else paths.push(relative(root, path))
        if (paths.length > 100000) throw new Error('Project is too large for plan freshness inspection; narrow the target before planning.')
      }
    }
    visit(root)
  }
  for (const path of paths.sort()) {
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Invalid plan scope path.')
    try {
      const info = lstatSync(absolute, { bigint: true })
      hash.update(`${path}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.mode}\0`)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') hash.update(`${path}\0deleted\0`)
      else throw error
    }
  }
  return hash.digest('hex')
}

export function savePlan(input: { projectRoot: string; task: string; body: string; sourceRunId?: string }, env: NodeJS.ProcessEnv = process.env): SavedPlan {
  const projectRoot = realpathSync(resolve(input.projectRoot))
  const source = input.sourceRunId ? loadPlanHandoff({ repoPath: projectRoot, task: input.task, planRunId: input.sourceRunId }) : null
  if (input.sourceRunId && !source) throw new Error('The Plan source is temporarily unavailable or unsafe; its artifacts are retained.')
  const identity = source ? handoffIdentity(source) : null
  if (identity && identity.planText !== null && identity.planText.trim() !== input.body.trim()) throw new Error('Saved plan body does not match the source artifact.')
  const plan = planSchema.parse({ ...input, projectRoot, schemaVersion: 1, id: `plan_${randomUUID()}`, createdAt: new Date().toISOString(),
    ...(identity?.planText?.trim() ? { sourceDigest: identity.digest } : {}),
    fingerprint: projectFingerprint(projectRoot, env), state: 'ready' })
  atomicPlanWrite(planPath(plan.id, env), plan)
  return plan
}

/** A write may have committed without acknowledgement; its identity must be inspected, not replayed. */
export class PlanSaveUncertainError extends Error {
  constructor(readonly planId: string, readonly path: string, readonly stagedPath: string) {
    super(`Plan saving outcome is uncertain; inspect retained Plan ${planId} before retrying.`)
    this.name = 'PlanSaveUncertainError'
  }
}

/** Guarded Windows store candidate; user-facing Plan saving remains contained pending qualification. */
export async function savePlanGuarded(input: { projectRoot: string; task: string; body: string; sourceRunId: string; signal?: AbortSignal }, env: NodeJS.ProcessEnv = process.env): Promise<SavedPlan> {
  const projectRoot = realpathSync(resolve(input.projectRoot))
  const source = await loadPlanHandoffGuarded({ repoPath: projectRoot, task: input.task, planRunId: input.sourceRunId, includePlanText: true, ...(input.signal ? { signal: input.signal } : {}) })
  if (!source?.contract || !source.sourceFingerprint || !source.sourceProjectIdentity || !source.sourcePlanText?.trim()) throw new Error('The complete Plan source is unavailable or unsafe; its artifacts are retained.')
  if (source.sourcePlanText.trim() !== input.body.trim()) throw new Error('Saved plan body does not match the source artifact.')
  const anchors = await acquireEffectDirectoryAnchors([projectRoot])
  let fingerprint: string
  try {
    input.signal?.throwIfAborted()
    const root = lstatSync(projectRoot, { bigint: true })
    const identity = root.ino > 0n ? createHash('sha256').update(`babel-snapshot-root-v1\0${root.dev}\0${root.ino}`).digest('hex') : null
    anchors.path(join(projectRoot, '__babel_plan_project_anchor__'))
    if (identity !== source.sourceProjectIdentity) throw new Error('Plan project identity changed before saving.')
    fingerprint = projectFingerprint(projectRoot, env)
    await new Promise<void>(resolveYield => setImmediate(resolveYield))
    input.signal?.throwIfAborted()
    anchors.path(join(projectRoot, '__babel_plan_project_anchor__'))
    const after = lstatSync(projectRoot, { bigint: true })
    if (after.dev !== root.dev || after.ino !== root.ino) throw new Error('Plan project identity changed during saving.')
  } finally { await anchors.release() }
  const plan = planSchema.parse({ projectRoot, task: input.task, body: input.body, sourceRunId: input.sourceRunId, schemaVersion: 1, id: `plan_${randomUUID()}`, createdAt: new Date().toISOString(), sourceDigest: source.sourceFingerprint, sourceProjectIdentity: source.sourceProjectIdentity, fingerprint, state: 'ready' })
  const write = await writeNewPlanWithDirectoryGuard({ stateRoot: resolveRuntimeUserStateRoot(env), planId: plan.id, content: `${JSON.stringify(plan)}\n`, ...(input.signal ? { signal: input.signal } : {}) })
  if (write.status === 'rejected') throw new Error(`Plan saving is unavailable: ${write.reason}`)
  if (write.status === 'unknown') throw new PlanSaveUncertainError(plan.id, write.path, write.stagedPath)
  return plan
}

function handoffIdentity(source: NonNullable<ReturnType<typeof loadPlanHandoff>>): { digest: string; planText: string | null } {
  const hash = createHash('sha256')
  let planText: string | null = null
  for (const name of ['manifest.json', 'request.json', 'contract.json', 'model_plan.json', 'plan.md', 'verification.json', 'plan_review.json', 'plan_review.md']) {
    const path = join(source.planRunDir, name)
    let info: BigIntStats
    try { info = lstatSync(path, { bigint: true }) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { hash.update(`${name}\0missing\0`); continue }
      throw error
    }
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 1024n * 1024n ||
        normalize(realpathSync(path)) !== normalize(join(realpathSync(source.planRunDir), name))) throw new Error('Unsafe saved plan source artifact.')
    const parent = normalize(realpathSync(source.planRunDir))
    const bytes = checkedPlanFileBytes(path, 1024 * 1024, () =>
      normalize(realpathSync(source.planRunDir)) === parent && normalize(realpathSync(path)) === normalize(join(parent, name)), undefined, info)
    if (!bytes) throw new Error('Unsafe saved plan source artifact.')
    if (name === 'plan.md') planText = bytes.toString('utf8')
    hash.update(`${name}\0${bytes.length}\0`).update(bytes)
  }
  return { digest: hash.digest('hex'), planText }
}

export function loadSavedPlan(id: string, env: NodeJS.ProcessEnv = process.env): SavedPlan {
  const path = planPath(id, env)
  const info = lstatSync(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 2n * 1024n * 1024n) throw new Error('Unsafe saved plan artifact.')
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const parent = normalize(realpathSync(dirname(path)))
  const bytes = checkedPlanFileBytes(path, 2 * 1024 * 1024, () =>
    planPath(id, env) === path && normalize(realpathSync(dirname(path))) === parent &&
    normalize(realpathSync(path)) === normalize(join(parent, `${id}.json`)), undefined, info)
  if (!bytes) throw new Error('Unsafe saved plan artifact.')
  const plan = planSchema.safeParse(JSON.parse(bytes.toString('utf8')))
  if (!plan.success || plan.data.id !== id) throw new Error('Invalid saved plan artifact.')
  return plan.data
}

export function shouldAutoApplyPlan(task: string, preference: boolean, planOnly = false): boolean {
  return preference && !planOnly && !hasExplicitEditDenial(task) && !/\b(?:plan[- ]only|read[- ]only|do not (?:apply|implement|change|edit)|don['’]t (?:apply|implement|change|edit))\b/i.test(task)
}

/** Serialize application and recheck scope; the existing executor still owns all permissions and budgets. */
export async function withSavedPlanApplication<T>(id: string, options: {
  projectRoot: string; env?: NodeJS.ProcessEnv; operatorMode?: string | undefined; preflight?: (plan: SavedPlan) => void | Promise<void>; execute: (plan: SavedPlan) => Promise<T>
}): Promise<T> {
  const env = options.env ?? process.env
  if (options.operatorMode === 'hard_plan' || options.operatorMode === 'dry_run') throw new Error('Current read-only operator restriction blocks plan application.')
  assertFiniteBudgetSupported('Plan application', options.projectRoot, env)
  const path = planPath(id, env)
  const lock = `${path}.lock`
  const fd = openSync(lock, 'wx', 0o600)
  try {
    const plan = loadSavedPlan(id, env)
    if (realpathSync(resolve(options.projectRoot)) !== plan.projectRoot) throw new Error('Plan belongs to another project; scope was not approved for this target.')
    if (plan.state !== 'ready') throw new Error('Plan has already started. Inspect or resume the associated run rather than applying it again.')
    if (projectFingerprint(plan.projectRoot, env) !== plan.fingerprint) throw new Error('Project changed after planning; create a fresh plan before application.')
    if (isReadOnlyChat(env) || /^(?:1|true)$/i.test(env['BABEL_DRY_RUN'] ?? '') || readRuntimeMode(env) === 'plan') throw new Error('Current read-only permissions block plan application.')
    const source = plan.sourceRunId ? loadPlanHandoff({ repoPath: plan.projectRoot, task: plan.task, planRunId: plan.sourceRunId }) : null
    if (!source) throw new Error('The saved plan source is unavailable or unsafe; inspect the retained plan and create a fresh plan before applying.')
    if (!source.contract) throw new Error('The saved plan contract is missing or unavailable; inspect the retained artifact and create a fresh plan before applying.')
    const identity = handoffIdentity(source)
    if (!plan.sourceDigest || !identity.planText?.trim() || plan.sourceDigest !== identity.digest) throw new Error('The saved plan source identity is missing or changed; inspect the retained plan and create a fresh plan before applying.')
    if (identity.planText !== null && identity.planText.trim() !== plan.body.trim()) throw new Error('Saved plan body does not match the source artifact.')
    const policy = loadEnterprisePolicy().policy
    const safetyPolicy = { ...policy, redaction: { ...policy.redaction, enabled: true } }
    if ([plan.body, plan.task].some(value => redactSecrets(value, safetyPolicy) !== value)) throw new Error('The saved plan contains credential-shaped content; inspect the retained artifact before creating a safe plan.')
    await options.preflight?.(plan)
    if (options.preflight) {
      const currentSource = plan.sourceRunId ? loadPlanHandoff({ repoPath: plan.projectRoot, task: plan.task, planRunId: plan.sourceRunId }) : null
      const currentPlan = loadSavedPlan(id, env)
      if (JSON.stringify(currentPlan) !== JSON.stringify(plan) || projectFingerprint(plan.projectRoot, env) !== plan.fingerprint || !currentSource || !currentSource.contract || handoffIdentity(currentSource).digest !== plan.sourceDigest) {
        throw new Error('Plan source or project changed during Apply admission; inspect the retained plan and create a fresh plan.')
      }
    }
    const attempt: SavedPlan = { ...plan, state: 'applying', attemptId: randomUUID(), attemptStartedAt: new Date().toISOString() }
    atomicPlanWrite(path, attempt)
    try {
      const result = await options.execute(attempt)
      if (!result || typeof result !== 'object' || !('status' in result) || typeof result.status !== 'string' ||
          !('runDir' in result) || typeof result.runDir !== 'string' || !result.runDir || result.runDir.length > 4096 || result.status.length > 200) {
        throw new Error('Apply returned no inspectable run result; inspect the attempt before retrying.')
      }
      atomicPlanWrite(path, { ...attempt, attemptRunDir: result.runDir, attemptOutcome: result.status,
        state: ['COMPLETE', 'COMPLETE_NO_MODIFICATION'].includes(result.status) ? 'applied' : 'unknown' })
      return result
    } catch (error) {
      // Once the executor is admitted, a local error alone cannot prove whether
      // its effects settled. Retain the artifact and block replay for inspection.
      atomicPlanWrite(path, { ...attempt, state: 'unknown' }); throw error
    }
  } finally { closeSync(fd); unlinkSync(lock) }
}

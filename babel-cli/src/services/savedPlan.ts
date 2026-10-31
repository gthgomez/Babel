/** Explicit, project-bound plan handoffs; planning never grants execution authority. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { resolveRuntimeUserStateRoot } from '../config/runtimePaths.js'
import { readRuntimeMode } from '../config/runtimeMode.js'
import { isReadOnlyChat } from '../agent/chatReadOnly.js'
import { assertFiniteBudgetSupported } from '../config/laneBudget.js'

const planSchema = z.object({ schemaVersion: z.literal(1), id: z.string(), projectRoot: z.string(), task: z.string(), body: z.string().min(1).max(1024 * 1024),
  createdAt: z.string(), fingerprint: z.string(), state: z.enum(['ready', 'applying', 'applied', 'failed']) })
export type SavedPlan = z.infer<typeof planSchema>

function planPath(id: string, env: NodeJS.ProcessEnv): string {
  if (!/^plan_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid saved plan ID. Legacy manual plan paths use the legacy apply command contract.')
  return join(resolveRuntimeUserStateRoot(env), 'plans', `${id}.json`)
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
  const git = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 })
  let paths: string[]
  if (git.status === 0) {
    paths = [...new Set(git.stdout.split('\0').filter(Boolean))]
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
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

export function savePlan(input: { projectRoot: string; task: string; body: string }, env: NodeJS.ProcessEnv = process.env): SavedPlan {
  const projectRoot = realpathSync(resolve(input.projectRoot))
  const plan = planSchema.parse({ ...input, projectRoot, schemaVersion: 1, id: `plan_${randomUUID()}`, createdAt: new Date().toISOString(),
    fingerprint: projectFingerprint(projectRoot, env), state: 'ready' })
  atomicPlanWrite(planPath(plan.id, env), plan)
  return plan
}

export function loadSavedPlan(id: string, env: NodeJS.ProcessEnv = process.env): SavedPlan {
  const path = planPath(id, env)
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Unsafe saved plan artifact.')
  const plan = planSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!plan.success || plan.data.id !== id) throw new Error('Invalid saved plan artifact.')
  return plan.data
}

export function shouldAutoApplyPlan(task: string, preference: boolean, planOnly = false): boolean {
  return preference && !planOnly && !/\b(?:plan[- ]only|read[- ]only|do not (?:apply|implement|change|edit)|don['’]t (?:apply|implement|change|edit))\b/i.test(task)
}

/** Serialize application and recheck scope; the existing executor still owns all permissions and budgets. */
export async function withSavedPlanApplication<T>(id: string, options: {
  projectRoot: string; env?: NodeJS.ProcessEnv; operatorMode?: string | undefined; execute: (plan: SavedPlan) => Promise<T>
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
    atomicPlanWrite(path, { ...plan, state: 'applying' })
    try {
      const result = await options.execute(plan)
      atomicPlanWrite(path, { ...plan, state: 'applied' })
      return result
    } catch (error) { atomicPlanWrite(path, { ...plan, state: 'failed' }); throw error }
  } finally { closeSync(fd); unlinkSync(lock) }
}
